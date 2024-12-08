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
      logger("error", `[order-processing-lambda] Store not found ${storeUrl}`);
      return;
    }

    // check if exists or not with the shopify_id
    const [doesOrderExists] = await Orders.find({
      orderShopifyId: payload.admin_graphql_api_id,
    });

    if (!doesOrderExists) {
      if (!payload?.line_items?.length) {
        logger("error", "No product exists");
        return;
      }
      // extracting customer details and fetching the user
      const { customer } = payload;
      const { billing_address: shipping_address } = payload;
      let user;
      logger("info", "Customer details", customer);
      const orderedBundles = [];
      const merchantOrderMap = {};
      const [doesUserAlreadyExists] = await Users.find({
        email: customer?.email,
      });
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
      // iterating over each item of the line items to create a map of individual merchants
      for (const item of payload.line_items) {
        logger("info", "Item", item);
        const lineItemProduct = `gid://shopify/Product/${item.product_id}`;
        logger("info", `Shopify id of product : ${lineItemProduct}`);
        const [doesBundleExists] = await Bundles.find({
          shopifyProductId: lineItemProduct,
        })
          .populate("store")
          .lean();

        if (!doesBundleExists) {
          logger("error", "The product is not a bundle.");
          return;
        }
        if (!doesBundleExists.store) {
          logger("error", "The bundles does not belong to a store");
          return;
        }

        if (!merchantOrderMap[doesBundleExists.store.shopName]) {
          merchantOrderMap[doesBundleExists.store.shopName] = {
            shopName: doesBundleExists.store.shopName,
            accessToken: doesBundleExists.store.accessToken,
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
        });
        merchantOrderMap[doesBundleExists.store.shopName].lineItems.push({
          variantId: defaultProductVarient,
          quantity: item.quantity,
        });
      }

      logger("info", "Merchant Map", merchantOrderMap);
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
          accessToken: order.accessToken,
          shopName: order.shopName,
          lineItems: order.lineItems,
        });
        logger("info", "Created the draftOrder", draftOrder);
        const completedOrder = await CompleteDraftOrder({
          accessToken: order.accessToken,
          shopName: order.shopName,
          draftOrderId: draftOrder.id,
          metafields: merchantMetafields,
        });
        const merchantOrder = await GetOrderFromDraftOrder({
          accessToken: order.accessToken,
          shopName: order.shopName,
          draftOrderId: draftOrder.id,
        });

        logger("info", "Placed the order", completedOrder);
        const merchantOrderObj = new Orders({
          amount: payload.current_subtotal_price,
          bundles: order.orderBundles,
          createdAt: payload.created_at,
          currency: payload.currency,
          discount: payload.current_total_discounts,
          vendor: storeUrl,
          status: "pending",
          user: user._id,
          orderShopifyId: merchantOrder.id,
          store: order.storeId,
          paymentStatus: payload.financial_status,
          paymentGateways: payload.payment_gateway_names,
        });
        await merchantOrderObj.save();
        const orderObj = new Orders({
          amount: payload.current_subtotal_price,
          bundles: order.orderBundles,
          createdAt: payload.created_at,
          currency: payload.currency,
          discount: payload.current_total_discounts,
          vendor: storeUrl,
          status: "pending",
          user: user._id,
          orderShopifyId: payload.admin_graphql_api_id,
          store: store._id,
          paymentStatus: payload.financial_status,
          paymentGateways: payload.payment_gateway_names,
        });
        await orderObj.save();
      }

      logger("info", "Successfully updated the inventory of the bundles");

      await Promise.all([orderObj.save(), merchantOrderObj.save()]);
      logger(
        "info",
        "Successfully placed the order on merchant and marketplace",
      );
    }
  } catch (error) {
    logger("error", `[order-create-event-handler] Error: ${error.message}`);
  }
}
