import logger from "#common-functions/logger/index.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import {
  FULFILLMENT_CREATE,
  GET_ORDER_FULFILLMENT_ID,
} from "#common-functions/shopify/queries.js";
import Orders from "#schemas/orders.js";
import Stores from "#schemas/stores.js";

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

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    }).lean();

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
    try {
      fulfillmentOrderId = await executeShopifyQueries({
        accessToken: marketPlace.accessToken,
        callback: (result) => {
          return result.data.fulfillmentCreate.fulfillment.id;
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
    const fulfillmentObj = {
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId,
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
