import logger from "#common-functions/logger/index.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import {
  FULFILLMENT_CREATE,
  GET_ORDER_FULFILLMENT_ID,
} from "#common-functions/shopify/queries.js";
import Orders from "#schemas/orders.js";
import Stores from "#schemas/stores.js";
import StoreBoxes from "#schemas/storeBoxes.js";

export default async function OrderFulfillHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[order-create-event-handler] Processing order: ${JSON.stringify(metadata["X-Shopify-Order-Id"])}`,
    );

    const orderId = metadata["X-Shopify-Order-Id"];
    const storeUrl = metadata["X-Shopify-Shop-Domain"];
    // fetching the market place
    const [store] = await Stores.find({
      storeUrl,
      isActive: true,
    }).lean();
    const [marketPlace] = await Stores.find({
      isInternalStore: true,
      isActive: true,
    }).lean();

    if (!store) {
      logger(
        "error",
        `[order-fulfillment-handler] Store not found ${storeUrl}`,
      );
      return;
    }
    const storeInventory = await StoreBoxes.findOne({
      store: store._id,
    }).lean();
    const marketBoxInventory = await StoreBoxes.findOne({
      store: marketPlace._id,
    }).lean();

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    })
      .populate({ path: "bundles.bundle" })
      .lean();

    // assuming the first object in the fulfillment array is the order fulfilled
    const fulfillment = payload.fulfillments[0];
    if (!doesOrderExists) {
      logger(
        "error",
        "[order-fulfillment-handler] Order not placed on the marketplace",
      );
      return;
    }

    // mark the order as fulfilled on the marketplace
    const { marketplaceOrderId } = doesOrderExists.metaData;
    logger("info", "Marketplace order id", marketplaceOrderId);
    let trackingUrl = "";
    if (fulfillment) {
      trackingUrl = fulfillment.tracking_url;
    }

    let fulfillmentOrderId;
    const orderLineItemVariants = [];
    try {
      fulfillmentOrderId = await executeShopifyQueries({
        accessToken: marketPlace.accessToken,
        callback: (result) => {
          const fulfillmentOrder =
            result.data.order?.fulfillmentOrders?.edges?.[0]?.node;
          if (!fulfillmentOrder) {
            return null;
          }
          fulfillmentOrder.lineItems.edges.forEach(({ node: fLineItem }) => {
            orderLineItemVariants.push({
              fulfillmentLineItem: fLineItem?.id,
              variantId: fLineItem.variant?.id,
              productName: fLineItem.variant?.product?.title,
            });
          });
          return fulfillmentOrder.id;
        },
        query: GET_ORDER_FULFILLMENT_ID,
        storeUrl: marketPlace.storeUrl,
        variables: {
          orderId: marketplaceOrderId,
        },
      });
      logger("info", "Successfully fetched the order fulfillment id");
    } catch (e) {
      logger(
        "error",
        "[order-fulfillment-handler] Could not find the order fulfillment id",
        e,
      );
      return;
    }

    if (!fulfillmentOrderId) {
      logger("error", "Error when fetching the order fulfillment.");
      throw new Error("invalid order id");
    }

    const trackingInfo = {};
    if (fulfillment.tracking_company) {
      trackingInfo.company = fulfillment.tracking_company;
    }
    if (fulfillment.tracking_number) {
      trackingInfo.number = fulfillment.tracking_number;
    }
    if (trackingUrl) {
      trackingInfo.url = trackingUrl;
    }
    const fulfillmentOrderLineItems = [];

    // iterate over line items
    // fetch the order fulfillments
    // find the bundle of the fulfilled bundle
    // extract the variant from the line items
    // find the variant inside the bundle.metadata.variantMapping
    // using the variantId found from the bundle.metadata.variantMapping
    // find the fulfillmentLineItem id using the variantId
    // add the fulFillmentLineItemId to the fulfillmentOrderLineItems
    // if the variant id is not inside bundle.metadata.variantMapping then try to find the packaging of the same.

    for (const item of fulfillment.line_items) {
      let marketplaceVariantId;
      const variantId = `gid://shopify/ProductVariant/${item.variant_id}`;
      doesOrderExists.bundles.forEach((bundle) => {
        const { variantMapping } = bundle.bundle.metadata;
        Object.entries(variantMapping).forEach(
          ([merchantVariantId, vendorVariant]) => {
            if (vendorVariant.id === variantId) {
              marketplaceVariantId = merchantVariantId;
            }
          },
        );
      });
      // is a bundle's variant
      if (marketplaceVariantId) {
        const marketplaceFulfillmentLineItem = orderLineItemVariants.find(
          (fulfillmentLineItem) =>
            fulfillmentLineItem.variantId === marketplaceVariantId,
        );
        if (marketplaceFulfillmentLineItem) {
          fulfillmentOrderLineItems.push({
            id: marketplaceFulfillmentLineItem.fulfillmentLineItem,
            quantity: item.quantity,
          });
        }
      } else {
        const isVariantPackaging = storeInventory.inventory.find((invItem) => {
          return invItem.shopify?.variantId === variantId;
        });
        if (!isVariantPackaging) {
          logger("error", "invalid line item");
          continue;
        }

        // find the variant of the box in marketplace
        const marketplaceShopifyBox = marketBoxInventory.inventory.find(
          (invItem) =>
            invItem.box.toString() === isVariantPackaging.box.toString(),
        );
        if (!marketplaceShopifyBox || !marketplaceShopifyBox.shopify) {
          logger("error", "invalid line item");
          continue;
        }
        const boxLineItem = orderLineItemVariants.find(
          (fulfillmentLineItem) =>
            fulfillmentLineItem.variantId ===
            marketplaceShopifyBox.shopify.variantId,
        );
        if (boxLineItem) {
          fulfillmentOrderLineItems.push({
            id: boxLineItem.fulfillmentLineItem,
            quantity: item.quantity,
          });
        }
      }
    }

    const fulfillmentObj = {
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId,
          fulfillmentOrderLineItems,
        },
      ],
      notifyCustomer: true,
      trackingInfo: {
        ...trackingInfo,
      },
    };
    try {
      await executeShopifyQueries({
        accessToken: marketPlace.accessToken,
        storeUrl: marketPlace.storeUrl,
        callback: null,
        query: FULFILLMENT_CREATE,
        variables: {
          fulfillment: fulfillmentObj,
        },
      });
    } catch (e) {
      logger(
        "error",
        "[order-fulfillment-handler] Could not fulfill the order",
        e,
      );
      return;
    }

    await Promise.all([
      Orders.findOneAndUpdate(
        { orderShopifyId: marketplaceOrderId },
        {
          status: "fulfilled",
          orderStatusUrl: payload.order_status_url,
          trackingUrl,
        },
      ),
      Orders.findByIdAndUpdate(doesOrderExists._id, {
        status: "fulfilled",
        orderStatusUrl: payload.order_status_url,
        trackingUrl,
      }),
    ]);
  } catch (error) {
    logger("error", `[order-fulfill-event-handler] Error: ${error.message}`);
  }
}
