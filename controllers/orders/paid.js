import logger from "#common-functions/logger/index.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import { ORDER_MARK_AS_PAID } from "#common-functions/shopify/queries.js";
import orders from "#schemas/orders.js";
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
    if (!doesOrderExists || !doesOrderExists?.metaData?.marketplaceOrderId) {
      logger(
        "error",
        "[order-paid-handler] The order is not placed through Marketplace",
      );
      return;
    }
    const { marketplaceOrderId } = doesOrderExists.metaData;

    const merchantUpdate = await Orders.findByIdAndUpdate(doesOrderExists._id, {
      paymentStatus: "paid",
    });
    if (!marketplaceOrderId) {
      logger(
        "error",
        "[order-paid-handler] The marketplace order id does not exists on the order.",
      );
      return;
    }

    if (!merchantUpdate) {
      throw new Error("Could not update merchant order");
    }
    const allIndividualOrders = await Orders.find({
      "metaData.marketplaceOrderId": marketplaceOrderId,
    }).lean();
    let isOrderCompletelyPaid = false;
    allIndividualOrders.forEach((order) => {
      if (order.paymentStatus === "paid") {
        isOrderCompletelyPaid = true;
      } else {
        isOrderCompletelyPaid = false;
      }
    });

    if (isOrderCompletelyPaid) {
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
        logger(
          "error",
          "[order-paid-handler] could not mark the order paid",
          e,
        );
        return;
      }

      const marketplaceUpdate = await Orders.findOneAndUpdate(
        {
          orderShopifyId: marketplaceOrderId,
        },
        {
          paymentStatus: "paid",
        },
      );
      if (!marketplaceUpdate) {
        throw new Error("Could not update the marketplace order");
      }
    }
    // await Promise.all([merchantUpdate, marketplaceUpdate]);
  } catch (error) {
    logger("error", `[order-paid-handler] Error: ${error.message}`);
  }
}
