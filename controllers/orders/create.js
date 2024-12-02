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
      let merchantAccessToken = "";
      let merchantShopName = "";
      const orderedBundles = [];
      let merchantStoreId = "";
      const lineItems = await Promise.all(
        payload.line_items.map(async (item) => {
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
          merchantAccessToken = doesBundleExists.store.accessToken;
          merchantShopName = doesBundleExists.store.shopName;
          merchantStoreId = doesBundleExists.store._id;
          orderedBundles.push({
            bundle: doesBundleExists._id,
            quantity: item.quantity,
          });
          const { id: defaultProductVarient } =
            await FetchProductDefaultVariant({
              accessToken: doesBundleExists.store.accessToken,
              productId: doesBundleExists.metadata.vendorShopifyId,
              shopName: doesBundleExists.store.shopName,
            });
          return {
            variantId: defaultProductVarient,
            quantity: item.quantity,
          };
        }),
      );
      if (!lineItems.length || !lineItems[0]?.variantId) {
        logger("error", "Something is wrong with the line items");
        return;
      }

      logger(
        "info",
        "Successfully build the line items for the order",
        lineItems,
      );

      const { customer } = payload;
      const { billing_address: shipping_address } = payload;
      logger("info", "Customer details", customer);

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
        accessToken: merchantAccessToken,
        shopName: merchantShopName,
        lineItems,
      });

      logger("info", "Created the draftOrder", draftOrder);
      const completedOrder = await CompleteDraftOrder({
        accessToken: merchantAccessToken,
        shopName: merchantShopName,
        draftOrderId: draftOrder.id,
      });
      const merchantOrder = await GetOrderFromDraftOrder({
        accessToken: merchantAccessToken,
        shopName: merchantShopName,
        draftOrderId: draftOrder.id,
      });

      logger("info", "Placed the order", completedOrder);
      let user;
      const [doesUserAlreadyExists] = await Users.find({
        email: customer?.email,
      });
      if (doesUserAlreadyExists) {
        user = doesUserAlreadyExists;
      } else {
        const userObj = new Users({
          name: `${customer?.first_name} ${customer.last_name}`,
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
      const orderObj = new Orders({
        amount: payload.current_subtotal_price,
        bundles: orderedBundles,
        createdAt: payload.created_at,
        currency: payload.currency,
        discount: payload.current_total_discounts,
        vendor: storeUrl,
        status: "pending",
        user: user._id,
        orderShopifyId: payload.admin_graphql_api_id,
        store: store._id,
      });

      const merchantOrderObj = new Orders({
        amount: payload.current_subtotal_price,
        bundles: orderedBundles,
        createdAt: payload.created_at,
        currency: payload.currency,
        discount: payload.current_total_discounts,
        vendor: storeUrl,
        status: "pending",
        user: user._id,
        orderShopifyId: merchantOrder.id,
        store: merchantStoreId,
      });

      await Promise.all(
        orderedBundles.map((b) => {
          return Bundles.findOneAndUpdate(
            { _id: b.bundle },
            { $inc: { inventory: -b.quantity } },
            { new: true },
          );
        }),
      );

      logger("info", "Successfully updated the inventory of the bundles");

      await Promise.all([orderObj.save(), merchantOrderObj.save()]);
      logger(
        "info",
        "Sucessfully placed the order on merchant and marketplace",
      );
    }
  } catch (error) {
    logger("error", `[order-create-event-handler] Error: ${error.message}`);
  }
}
