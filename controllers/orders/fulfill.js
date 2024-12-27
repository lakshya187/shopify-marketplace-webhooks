import logger from "#common-functions/logger/index.js";
import CreateFulfillment from "#common-functions/shopify/createFulfillment.js";
import GetOrderFulfillmentId from "#common-functions/shopify/getOrderFulfillmentId.js";
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
      logger("error", `[order-processing-lambda] Store not found ${storeUrl}`);
      return;
    }

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    }).lean();

    // assuming the first object in the fullmint array is the order fullfilled
    const fulfillment = payload.fulfillments[0];
    if (!doesOrderExists) {
      logger("error", "Order not placed on the marketplace");
      return;
    }

    // mark the order as fulfilled on the marketplace
    const { marketplaceOrderId } = doesOrderExists.metaData;
    logger("info", "Marketplace order id", marketplaceOrderId);
    let trackingUrl = "";
    if (fulfillment) {
      trackingUrl = fulfillment.tracking_url;
    }
    const fulfillmentOrderId = await GetOrderFulfillmentId({
      accessToken: marketPlace.accessToken,
      orderId: marketplaceOrderId,
      storeUrl: marketPlace.storeUrl,
    });
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

    await Promise.all([
      CreateFulfillment({
        accessToken: marketPlace.accessToken,
        fulfillment: fulfillmentObj,
        storeUrl: marketPlace.storeUrl,
      }),
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
