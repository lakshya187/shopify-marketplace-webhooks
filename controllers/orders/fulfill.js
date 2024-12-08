import logger from "#common-functions/logger/index.js";
import Orders from "#schemas/orders.js";
import Stores from "#schemas/stores.js";

export default async function OrderCreateEventHandler(payload, metadata) {
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

    if (!store) {
      logger("error", `[order-processing-lambda] Store not found ${storeUrl}`);
      return;
    }

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    });

    // assuming the first object in the fullmint array is the order fullfilled
    const fullfilment = payload.fulfillments[0];
    if (!doesOrderExists) {
      logger("error", "Order not placed on the marketplace");
      return;
    }
    let trackingUrl = "";
    if (fullfilment) {
      trackingUrl = fullfilment.tracking_url;
    }
    logger("info", "Tracking url", payload.tracking_url);
    if (!payload.cancelled_at && payload.confirmed) {
      await Orders.findByIdAndUpdate(doesOrderExists._id, {
        status: "fulfilled",
        orderStatusUrl: payload.order_status_url,
        trackingUrl,
      });
    }
  } catch (error) {
    logger("error", `[order-fulfill-event-handler] Error: ${error.message}`);
  }
}
