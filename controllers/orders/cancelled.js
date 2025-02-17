import logger from "#common-functions/logger/index.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import { CANCEL_ORDER } from "#common-functions/shopify/queries.js";
import Orders from "#schemas/orders.js";
import Stores from "#schemas/stores.js";
export const OrderCancelledHandler = async (payload, metadata) => {
  try {
    // extract the order id from the payload

    const marketplace = await Stores.findOne({
      isInternalStore: true,
      isActive: true,
    }).lean();
    if (!marketplace) {
      logger("error", "[order-cancelled-handler] Marketplace not found");
      return;
    }
    const { admin_graphql_api_id } = payload;
    if (!admin_graphql_api_id) {
      logger(
        "error",
        "[order-cancelled-handler] Order Id not found in the payload",
      );
      return;
    }

    const isOrderPresent = await Orders.findOne({
      orderShopifyId: admin_graphql_api_id,
    }).lean();
    if (!isOrderPresent) {
      logger(
        "error",
        "[order-cancelled-handler] Order not found in the marketplace",
      );
      return;
    }

    const { marketplaceOrderId } = isOrderPresent.metaData;
    if (!marketplaceOrderId) {
      logger(
        "error",
        "[order-cancelled-handler] Marketplace order id not found",
      );
      return;
    }
    const marketplaceOrder = await Orders.findOne({
      orderShopifyId: marketplaceOrderId,
    }).lean();
    if (!marketplaceOrder) {
      logger("error", "[order-cancelled-handler] Marketplace order not found");
      return;
    }

    const cancelOrderPayload = {
      notifyCustomer: true,
      orderId: marketplaceOrderId,
      reason: "CUSTOMER",
      refund: true,
      restock: true,
      staffNote: "",
    };
    try {
      await executeShopifyQueries({
        query: CANCEL_ORDER,
        variables: cancelOrderPayload,
        accessToken: marketplace.accessToken,
        storeUrl: marketplace.storeUrl,
      });
      logger("info", "[order-cancelled-handler] Order cancelled on shopify");
    } catch (e) {
      logger(
        "error",
        "[order-cancelled-handler] Error while cancelling order on shopify",
        e,
      );
      return;
    }
    const updatedMarketplaceOrder = Orders.findOneAndUpdate(
      { _id: marketplaceOrder._id },
      {
        status: "cancelled",
        paymentStatus: "refunded",
        cancelledOn: new Date(Date.now()),
      },
      { new: true },
    ).lean();
    const updatedMerchantOrder = Orders.findOneAndUpdate(
      { _id: isOrderPresent._id },
      {
        status: "cancelled",
        paymentStatus: "refunded",
        cancelledOn: new Date(Date.now()),
      },
    );
    await Promise.all([updatedMarketplaceOrder, updatedMerchantOrder]);
    logger("info", "[order-cancelled-handler] Order cancelled successfully");
  } catch (e) {
    logger("error", "[order-cancelled-handler] Error in processing order", e);
  }
};
