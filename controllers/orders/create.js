import logger from "#common-functions/logger/index.js";
import Bundles from "#schemas/bundles.js";
import Orders from "#schemas/orders.js";
import Users from "#schemas/users.js";
import Stores from "#schemas/stores.js";
import FetchProductDefaultVariant from "#common-functions/shopify/getProductDefaultVariant.js";
import CreateDraftOrder from "#common-functions/shopify/createDraftOrder.js";
import CompleteDraftOrder from "#common-functions/shopify/completeDraftOrder.js";
import GetOrderFromDraftOrder from "#common-functions/shopify/getOrderFromDraftOrderId.js";

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
      isInternalStore: true,
    }).lean();

    if (!store) {
      logger(
        "error",
        `[order-processing-lambda] Marketplace not found ${storeUrl}`,
      );
      return;
    }

    // check if order exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    }).lean();
    if (doesOrderExists) {
      logger(
        "error",
        "[order-processing-lambda] Order already exists in the database.",
      );
      return;
    }
    if (!payload?.line_items?.length) {
      logger("error", "No product exists");
      return;
    }
    // extracting customer details and fetching the user
    const { customer } = payload;
    const { billing_address: shipping_address } = payload;
    let user;
    logger("info", "Customer details", customer);

    const [doesUserAlreadyExists] = await Users.find({
      email: customer?.email,
    });
    // creating a merhchant attributes to store the notes_attributes
    const { note_attributes: noteAttributes } = payload;
    const merchantMetafields = {};
    if (noteAttributes?.length) {
      merchantMetafields["metafields"] = [];
      noteAttributes.forEach((n) => {
        merchantMetafields["metafields"].push({
          namespace: "gifting",
          key: n?.name,
          type: "single_line_text_field",
          value: n?.value,
        });
      });
    }

    const noteObj = {};
    const isGiftWrappingEnabled = noteAttributes.find(
      (a) => a.name === "gift-wrapping",
    );
    if (payload.note) {
      noteObj["note"] = payload.note;
    }
    if (isGiftWrappingEnabled) {
      noteObj["note"] = `${noteObj["note"] ?? ""} (wrap this order.)`.trim();
    }

    // upserting the user
    if (doesUserAlreadyExists) {
      user = doesUserAlreadyExists;
    } else {
      const userObj = new Users({
        name: `${customer?.first_name} ${customer.last_name ?? ""}`.trim(),
        email: customer?.email,
        contactNumber: customer.phone,
        address: {
          pincode: shipping_address.zip,
          addressLineOne: shipping_address.address1,
          addressLineTwo: shipping_address.address2,
          country: shipping_address.country,
          state: shipping_address.city,
        },
      });
      user = await userObj.save();
    }
    // iterating over each item of the line items to create a map of individual merchants and creating order bundles for the particuller order
    const orderedBundles = [];
    const merchantOrderMap = {};
    for (const item of payload.line_items) {
      const lineItemProduct = `gid://shopify/Product/${item.product_id}`;
      const [doesBundleExists] = await Bundles.find({
        shopifyProductId: lineItemProduct,
      })
        .populate("store")
        .lean();

      if (!doesBundleExists) {
        logger("error", "The product is not a bundle.");
        continue;
      }
      if (!doesBundleExists.store) {
        logger("error", "The bundles does not belong to a store");
        return;
      }

      if (!merchantOrderMap[doesBundleExists.store.shopName]) {
        merchantOrderMap[doesBundleExists.store.shopName] = {
          shopName: doesBundleExists.store.shopName,
          accessToken: doesBundleExists.store.accessToken,
          storeUrl: doesBundleExists.store.storeUrl,
          storeId: doesBundleExists.store._id,
          lineItems: [],
          orderBundles: [],
        };
      }

      merchantOrderMap[doesBundleExists.store.shopName].orderBundles.push({
        bundle: doesBundleExists._id,
        quantity: item.quantity,
      });
      const { id: defaultProductVarient } = await FetchProductDefaultVariant({
        accessToken: doesBundleExists.store.accessToken,
        productId: doesBundleExists.metadata.vendorShopifyId,
        shopName: doesBundleExists.store.shopName,
        storeUrl: doesBundleExists.store.storeUrl,
      });
      merchantOrderMap[doesBundleExists.store.shopName].lineItems.push({
        variantId: defaultProductVarient,
        quantity: item.quantity,
      });
    }
    // creating orders for each merchant
    const orderObjs = Object.values(merchantOrderMap);
    for (const order of orderObjs) {
      const draftOrder = await CreateDraftOrder({
        user: {
          email: customer.email,
          address: {
            address1: shipping_address.address1,
            city: shipping_address.city,
            province: shipping_address.province,
            country: shipping_address.country,
            zip: shipping_address.zip,
          },
        },
        note: noteObj,
        accessToken: order.accessToken,
        shopName: order.shopName,
        lineItems: order.lineItems,
        storeUrl: order.storeUrl,
        metafields: merchantMetafields,
        tags: {
          tags: "generated_via_giftclub",
        },
      });
      logger("info", "Created the draftOrder");
      const completedOrder = await CompleteDraftOrder({
        accessToken: order.accessToken,
        shopName: order.shopName,
        draftOrderId: draftOrder.id,
        storeUrl: order.storeUrl,
        paymentPending: payload.financial_status === "paid" ? false : true,
      });
      const merchantOrder = await GetOrderFromDraftOrder({
        accessToken: order.accessToken,
        shopName: order.shopName,
        draftOrderId: draftOrder.id,
        storeUrl: order.storeUrl,
      });

      logger("info", "Placed the order");
      const merchantOrderObj = new Orders({
        amount: payload.current_subtotal_price,
        bundles: order.orderBundles,
        createdAt: payload.created_at,
        currency: payload.currency,
        discount: payload.current_total_discounts,
        vendor: order.storeUrl,
        status: "pending",
        user: user._id,
        orderShopifyId: merchantOrder.id,
        store: order.storeId,
        paymentStatus: payload.financial_status,
        paymentGateways: payload.payment_gateway_names,
        metaData: {
          marketplaceOrderId: payload.admin_graphql_api_id,
        },
      });

      const marketplaceOrder = new Orders({
        amount: payload.current_subtotal_price,
        bundles: order.orderBundles,
        createdAt: payload.created_at,
        currency: payload.currency,
        discount: payload.current_total_discounts,
        vendor: order.storeUrl,
        status: "pending",
        user: user._id,
        orderShopifyId: payload.admin_graphql_api_id,
        store: store._id,
        paymentStatus: payload.financial_status,
        paymentGateways: payload.payment_gateway_names,
      });
      await Promise.all([marketplaceOrder.save(), merchantOrderObj.save()]);
    }
    logger("info", "Successfully placed the order on merchant and marketplace");
  } catch (error) {
    logger("error", `[order-create-event-handler] Error: ${error.message}`);
  }
}
