import logger from "#common-functions/logger/index.js";
import Bundles from "#schemas/bundles.js";
import Orders from "#schemas/orders.js";
import Users from "#schemas/users.js";
import Boxes from "#schemas/boxes.js";
import Stores from "#schemas/stores.js";
import Notifications from "#schemas/notifications.js";
import StoreBoxes from "#schemas/storeBoxes.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import { GET_PRODUCT_USING_VARIANT_ID } from "#common-functions/shopify/queries.js";
import { CreateOrder, CreateProduct } from "../../helpers/orders/index.js";

export default async function OrderCreateEventHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[order-create-event-handler] Processing order: ${JSON.stringify(metadata["X-Shopify-Order-Id"])}`,
    );
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

    const [doesUserAlreadyExists] = await Users.find({
      email: customer?.email,
    });

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
      merchantOrderMap[doesBundleExists.store.shopName].lineItems.push({
        variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
        quantity: item.quantity,
        attributes: item.properties,
        discount: item.discount_allocations,
      });
    }
    // creating orders for each merchant

    const orderObjs = Object.values(merchantOrderMap);
    for (const order of orderObjs) {
      const storeInventory = await StoreBoxes.findOne({
        store: order.storeId,
      })
        .populate({ path: "inventory.box" })
        .lean();
      let orderPrice = 0;
      const orderLineItems = [];
      for (const lineItem of order.lineItems) {
        const { variantId, quantity } = lineItem;
        // const variantProduct = await

        let variantProduct;
        try {
          variantProduct = await executeShopifyQueries({
            accessToken: store.accessToken,
            storeUrl: store.storeUrl,
            query: GET_PRODUCT_USING_VARIANT_ID,
            variables: {
              variantId,
            },
            callback: (result) => {
              const variant = result.data?.productVariant;
              if (!variant) {
                return null;
              }
              // Extracting price
              const { id, price, title } = variant;

              return {
                id,
                price,
                title,
                productId: variant?.product?.id,
              };
            },
          });
        } catch (e) {
          logger("error", "invalid product id", e);
          continue;
        }

        if (!variantProduct) {
          logger("error", "invalid product id", e);
          continue;
        }

        if (variantProduct) {
          const bundle = await Bundles.findOne({
            shopifyProductId: variantProduct.productId,
          }).lean();
          if (!bundle) {
            logger(
              "error",
              "[order-create-event-handler] Product id is invalid",
            );
            return;
          }
          orderPrice += bundle.price;
          const variant = bundle.metadata.variantMapping[variantProduct.id];

          const isProductPackaging = lineItem.attributes.find(
            (a) => a.name === "packaging" && a.value === "true",
          );
          if (isProductPackaging) {
            const isStoreInventoryAvailable = storeInventory.inventory.find(
              (inv) => inv.box._id.toString() === bundle.box.toString(),
            );
            if (
              isStoreInventoryAvailable &&
              isStoreInventoryAvailable.remaining &&
              isStoreInventoryAvailable.shopify
            ) {
              orderPrice += Number(isStoreInventoryAvailable.box.price);
              orderLineItems.push({
                variantId: isStoreInventoryAvailable.shopify.variantId,
                quantity,
              });
            }
          }
          const discountObj = {};
          if (lineItem?.discount && lineItem?.discount?.length) {
            let value = 0;
            lineItem?.discount.forEach((cunt) => {
              value += Number(cunt.amount) ?? 0;
            });
            discountObj["appliedDiscount"] = {
              value,
              valueType: "FIXED_AMOUNT",
            };
            orderPrice -= value;
          }
          // when lineItem is non packaging
          orderLineItems.push({
            variantId: variant.id,
            quantity,
            ...discountObj,
          });
        }
      }
      const draftOrderVariables = {
        input: {
          lineItems: orderLineItems,
          email: customer.email,
          shippingAddress: {
            address1: shipping_address.address1,
            city: shipping_address.city,
            province: shipping_address.province,
            country: shipping_address.country,
            zip: shipping_address.zip,
          },
          tags: "generated_via_giftclub",
        },
      };

      const merchantOrder = await CreateOrder({
        draftOrderVariables,
        financial_status: payload.financial_status,
        store: {
          accessToken: order.accessToken,
          storeUrl: order.storeUrl,
        },
      });

      logger("info", "Placed the order");
      const merchantOrderObj = new Orders({
        amount: orderPrice,
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
      const merchantNotification = new Notifications({
        category: "orders",
        description: "A new order from Giftlcub is waiting for you to fulfill!",
        store: order.storeId,
        title: "You have a new order",
      });
      logger("info", "successfully created notification for the merchant");
      const marketplaceOrder = new Orders({
        amount: orderPrice,
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
      // const storeInventory  =await
      // for (const packagingOrder of order.orderBundles) {
      //   if (packagingOrder.box) {
      //     // await updateBoxInventoryOnBundles({
      //     //   accessToken: store.accessToken,
      //     //   box: packagingOrder.box,
      //     //   delta: -Number(packagingOrder.quantity),
      //     //   storeId: order.storeId,
      //     //   storeUrl: store.storeUrl,
      //     //   excludedBundleId: packagingOrder.bundle,
      //     // });
      //     // logger(
      //     //   "info",
      //     //   "Successfully updated the inventory of all the box packagings",
      //     // );
      //     await deductInventory({
      //       boxId: packagingOrder.box,
      //       delta: Number(packagingOrder.quantity),
      //       storeId: order.storeId,
      //     });
      //     logger(
      //       "info",
      //       "successfully updated the box inventory in the database.",
      //     );
      //   }
      //   await Bundles.findByIdAndUpdate(
      //     packagingOrder.bundle,
      //     {
      //       $inc: { inventory: -Number(packagingOrder.quantity) },
      //     },
      //     { new: true },
      //   );
      //   logger("info", "Successfully updated the bundle inventory");
      // }
      await Promise.all([
        marketplaceOrder.save(),
        merchantOrderObj.save(),
        merchantNotification.save(),
      ]);
    }
    logger("info", "Successfully placed the order on merchant and marketplace");
  } catch (error) {
    logger("error", `[order-create-event-handler] Error: ${error.message}`);
  }
}

const PlaceOrderOnShopify = async ({}) => {};
