import logger from "#common-functions/logger/index.js";
import CreateFulfillment from "#common-functions/shopify/createFulfillment.js";
import MarkOrderPaid from "#common-functions/shopify/markOrderPaid.js";
import Orders from "#schemas/orders.js";
import Stores from "#schemas/stores.js";

export default async function OrderPaidHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[order-paid-event-handler] Processing order: ${JSON.stringify(metadata["X-Shopify-Order-Id"])}`,
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
    if (!doesOrderExists) {
      logger("info", "The order is not placed through Marketplace");
      return;
    }
    const { marketplaceOrderId } = doesOrderExists.metaData;
    if (!marketplaceOrderId) {
      logger("error", "The marketplace order id does not exists on the order.");
      return;
    }

    const marketplaceShopifyUpdate = MarkOrderPaid({
      accessToken: marketPlace.accessToken,
      storeUrl: marketPlace.storeUrl,
      orderId: marketplaceOrderId,
    });
    const merchantUpdate = Orders.findByIdAndUpdate(doesOrderExists._id, {
      paymentStatus: "paid",
    });
    const marketplaceUpdate = Orders.findOneAndUpdate(
      {
        orderShopifyId: marketplaceOrderId,
      },
      {
        paymentStatus: "paid",
      },
    );
    await Promise.all([
      marketplaceShopifyUpdate,
      merchantUpdate,
      marketplaceUpdate,
    ]);
  } catch (error) {
    logger("error", `[order-fulfill-event-handler] Error: ${error.message}`);
  }
}
