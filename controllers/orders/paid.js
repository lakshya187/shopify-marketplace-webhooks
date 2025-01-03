import logger from "#common-functions/logger/index.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import { ORDER_MARK_AS_PAID } from "#common-functions/shopify/queries.js";
import Orders from "#schemas/orders.js";
import Stores from "#schemas/stores.js";

export default async function OrderPaidHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[order-paid-handler] Processing order: ${JSON.stringify(metadata["X-Shopify-Order-Id"])}`,
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
      logger("error", `[order-paid-handler] Store not found ${storeUrl}`);
      return;
    }

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    }).lean();
    if (!doesOrderExists) {
      logger(
        "error",
        "[order-paid-handler] The order is not placed through Marketplace",
      );
      return;
    }
    const { marketplaceOrderId } = doesOrderExists.metaData;
    if (!marketplaceOrderId) {
      logger(
        "error",
        "[order-paid-handler] The marketplace order id does not exists on the order.",
      );
      return;
    }
    try {
      await executeShopifyQueries({
        accessToken: marketPlace.accessToken,
        storeUrl: marketPlace.storeUrl,
        query: ORDER_MARK_AS_PAID,
        callback: null,
        variables: {
          input: {
            id: marketplaceOrderId,
          },
        },
      });
      logger("info", "Successfully marked the order as paid.");
    } catch (e) {
      logger("error", "[order-paid-handler] could not mark the order paid", e);
      return;
    }

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
    await Promise.all([merchantUpdate, marketplaceUpdate]);
  } catch (error) {
    logger("error", `[order-paid-handler] Error: ${error.message}`);
  }
}
