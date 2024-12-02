import logger from "#common-functions/logger/index.js";
import Bundles from "#schemas/bundles.js";
import Orders from "#schemas/orders.js";
import Users from "#schemas/users.js";
import Stores from "#schemas/stores.js";

export default async function OrderCreateEventHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[order-create-event-handler] Processing order: ${JSON.stringify(metadata["X-Shopify-Order-Id"])}`,
    );

    const orderId = metadata["X-Shopify-Order-Id"];
    const storeUrl = metadata["X-Shopify-Shop-Domain"];

    const [store] = await Stores.find({
      storeUrl,
      isActive: true,
      isInternalStore: true,
    }).lean();

    if (!store) {
      logger("error", `[order-processing-lambda] Store not found ${storeUrl}`);
      return;
    }

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    });

    if (!doesOrderExists) {
      // assuming, if the line items will be a single bundle, then take the first item of the line items and fetch the it from the database for validation
      const bundle = payload.line_items[0];
      if (!bundle) {
        logger("error", "No product exists");
        return;
      }
      const productId = `gid://shopify/Product/${bundle.product_id}`;
      const [doesBundleExists] = await Bundles.find({
        shopifyProductId: productId,
      }).lean();

      if (!doesBundleExists) {
        logger("error", "The product is not a bundle.");
        return;
      }

      const { customer } = payload;
      const { shipping_address } = payload;
      // if the line item exists in the database, build  objects forˀ orders, users.
      const userObj = new Users({
        name: customer?.name ?? "User name not found",
        email: customer?.email ?? "Email not found",
        contactNumber: customer.mobileNumber ?? "Mobile number not found",
        address: {
          pincode: shipping_address.pincode ?? "Pincode not found",
          addressLineOne:
            shipping_address.address_line_one ?? "Address line one not found",
          addressLineTwo:
            shipping_address.address_line_two ?? "Address line two not found",
          country: shipping_address.country ?? "Country not found",
          state: shipping_address.province ?? "State not found",
        },
      });

      const user = await userObj.save();
      const orderObj = new Orders({
        amount: payload.current_subtotal_price,
        bundle: doesBundleExists._id,
        createdAt: payload.created_at,
        currency: payload.currency,
        discount: payload.current_total_discounts,
        vendor: storeUrl,
        status: "pending",
        user: user._id,
        orderShopifyId: payload.admin_graphql_api_id,
        store: store._id,
      });
      const order = await orderObj.save();
      logger(
        "info",
        `[order-create-event-handler] Order created: ${order._id}`,
      );
    }
  } catch (error) {
    logger("error", `[order-create-event-handler] Error: ${error.message}`);
  }
}
