import {
  CREATE_DRAFT_ORDER,
  CREATE_PRODUCT_WITH_MEDIA,
  DRAFT_ORDER_COMPLETE,
  GET_ORDER_ID_FROM_DRAFT_ORDER,
  GET_PRODUCT_DETAILS,
  GET_PRODUCT_USING_VARIANT_ID,
  GET_PRODUCT_VARIANTS_INVENTORY,
  GET_STORE_LOCATION,
  INVENTORY_ADJUST_QUANTITIES,
  PRODUCT_VARIANT_BULK_UPDATE,
} from "#common-functions/shopify/queries.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import logger from "#common-functions/logger/index.js";
import Bundles from "#schemas/bundles.js";

export const CreateProduct = async ({ variantId, marketPlace, merchant }) => {
  let shopifyProductVariant;
  try {
    shopifyProductVariant = await executeShopifyQueries({
      accessToken: marketPlace.accessToken,
      storeUrl: marketPlace.storeUrl,
      query: GET_PRODUCT_USING_VARIANT_ID,
      callback: (result) => {
        const variant = result.data?.productVariant;
        if (!variant) {
          return null;
        }

        // Extracting price
        const { id, price, title } = variant;
        // Extracting the metafield with namespace "custom" and key "bundle_components"
        const metafield = variant.product?.metafields?.edges.find(
          (edge) =>
            edge.node.namespace === "custom" &&
            edge.node.key === "bundle_components",
        )?.node;

        const bundleComponents = metafield ? JSON.parse(metafield.value) : null;

        return {
          id,
          price,
          title,
          productId: variant.product.id,
          bundleComponents,
        };
      },
      variables: {
        variantId,
      },
    });
    logger("successfully fetched the product using the variant id");
  } catch (e) {
    logger(
      "error",
      "[create-product] Error when fetching the product using the product variant id",
      e,
    );
  }
  if (!shopifyProductVariant) {
    throw new Error("Invalid variant id provided");
  }

  const newProductVariables = {
    input: {
      title: `${shopifyProductVariant.title} temp`,
      descriptionHtml: `This product is a temp project auto generated for ${shopifyProductVariant.title} order placement.`,
      tags: ["auto-generated"],
      status: "DRAFT",
      productOptions: [
        {
          name: "Default",
          values: [{ name: `${shopifyProductVariant.title}` }],
        },
      ],
    },
    media: [],
  };

  let newProduct;
  try {
    newProduct = await executeShopifyQueries({
      query: CREATE_PRODUCT_WITH_MEDIA,
      accessToken: merchant.accessToken,
      callback: (result) => {
        return result.data?.productCreate?.product;
      },
      storeUrl: merchant.storeUrl,
      variables: newProductVariables,
    });
    logger("info", "Successfully created the product on the store");
  } catch (e) {
    logger("error", `[create-product] Could not create store product`, e);
    throw new Error(e);
  }

  if (!newProduct) {
    logger("error", "[create-product] Could not create a new product ", e);
    throw new Error("Could not create a new product on the marketplace");
  }
  const newVariant = newProduct.variants?.edges[0]?.node;
  if (!newVariant) {
    logger("error", "could not find the new variant.");
    return;
  }
  const variantUpdatePayload = {
    productId: newProduct.id,
    variants: [
      {
        // title: `${shopifyProductVariant.title} `,
        id: newVariant.id,
        price: Number(shopifyProductVariant.price),
      },
    ],
  };
  try {
    await executeShopifyQueries({
      variables: variantUpdatePayload,
      accessToken: merchant.accessToken,
      callback: null,
      query: PRODUCT_VARIANT_BULK_UPDATE,
      storeUrl: merchant.storeUrl,
    });
  } catch (e) {
    logger(
      "error",
      "[create-product] Could not update the new product variant",
    );
    throw e;
  }

  return { product: newProduct, variant: newVariant };
};

export const CreateOrder = async ({
  store,
  draftOrderVariables,
  financial_status,
}) => {
  if (!store?.accessToken || !store?.storeUrl) {
    throw new Error("Store access token or store URL is missing.");
  }
  if (!["paid", "pending"].includes(financial_status)) {
    throw new Error("Invalid financial_status value.");
  }
  if (!draftOrderVariables) {
    throw new Error("Draft order variables are required.");
  }

  let draftOrder;
  try {
    draftOrder = await executeShopifyQueries({
      accessToken: store.accessToken,
      storeUrl: store.storeUrl,
      query: CREATE_DRAFT_ORDER,
      callback: (result) => {
        if (!result?.data?.draftOrderCreate?.draftOrder) {
          throw new Error("Failed to create draft order: Invalid response.");
        }
        return result.data.draftOrderCreate.draftOrder;
      },
      variables: draftOrderVariables,
    });
    logger("info", "Created the draftOrder");
  } catch (e) {
    logger(
      "error",
      "[order-create-event-handler] Could not create the draft order.",
      e,
    );
    return;
  }
  if (!draftOrder || !draftOrder.id) return null;
  try {
    await executeShopifyQueries({
      accessToken: store.accessToken,
      storeUrl: store.storeUrl,
      query: DRAFT_ORDER_COMPLETE,
      callback: null,
      variables: {
        id: draftOrder.id,
        paymentPending: financial_status === "paid" ? false : true,
      },
    });
  } catch (e) {
    logger(
      "error",
      "[order-created-event-handler] Could not confirm the draft order",
      e,
    );
  }
  let merchantOrder;
  try {
    merchantOrder = await executeShopifyQueries({
      accessToken: store.accessToken,
      storeUrl: store.storeUrl,
      variables: {
        draftOrderId: draftOrder.id,
      },
      query: GET_ORDER_ID_FROM_DRAFT_ORDER,
      callback: (result) => {
        return result.data.draftOrder.order;
      },
    });
    logger("info", "Successfully fetched the merchant order");
  } catch (e) {
    logger(
      "error",
      "[order-create-event-handler] Could not fetch the merchant order",
      e,
    );
    return null;
  }

  return merchantOrder;
};

export const updateBoxInventoryOnBundles = async ({
  box,
  storeId,
  accessToken,
  storeUrl,
  delta,
  excludedBundleId,
}) => {
  // Update all the bundles using the box id of the store on shopify.
  // STEPS:
  // find all the bundles using the packaging
  // fetch the packaging variant
  // find the inventory item
  // update with new inventory.
  const allActiveBundlesUsingBox = await Bundles.find({
    status: "active",
    isCreatedOnShopify: true,
    box,
    store: storeId,
    _id: { $ne: excludedBundleId }, // Exclude the specified bundle ID
  }).lean();
  await Promise.all(
    allActiveBundlesUsingBox.map(async (bundle) => {
      let packagingVariantNode;
      try {
        packagingVariantNode = await executeShopifyQueries({
          accessToken,
          storeUrl,
          query: GET_PRODUCT_DETAILS,
          variables: {
            id: bundle.shopifyProductId,
          },
          callback: (result) => {
            const product = result?.data?.product;
            return product?.variants?.edges.find(
              ({ node }) => node.title === BUNDLE_PACKAGING_VARIANT,
            );
          },
        });
      } catch (e) {
        logger(
          "error",
          "[update-box-inventory-using-box] Could not fetch the packaging variant",
          e,
        );
      }
      if (packagingVariantNode && packagingVariantNode.node.id) {
        const { node: packagingVariant } = packagingVariantNode;
        let locations = [];
        let location;
        try {
          locations = await executeShopifyQueries({
            query: GET_STORE_LOCATION,
            accessToken,
            callback: (result) => result.data.locations.edges,
            storeUrl,
            variables: null,
          });
          logger("info", "Successfully fetched the store locations");
        } catch (e) {
          logger(
            "error",
            `[update-box-inventory-using-box] Could not get the location of the store`,
            e,
          );
          throw new Error(e);
        }
        if (locations.length) {
          const defaultLocation = locations.find(
            (l) => l.node.name === "Shop location",
          );
          if (!defaultLocation) {
            location = locations[0].node.id;
          } else {
            location = defaultLocation.node.id;
          }
        }

        const variantInventoryVariables = {
          variantIds: [packagingVariant.id],
        };
        let inventoryUpdateObjs;
        try {
          inventoryUpdateObjs = await executeShopifyQueries({
            accessToken,
            callback: (result) => {
              return result?.data?.nodes.map((obj) => {
                return {
                  delta,
                  inventoryItemId: obj.inventoryItem.id,
                  locationId: location,
                };
              });
            },
            query: GET_PRODUCT_VARIANTS_INVENTORY,
            storeUrl,
            variables: variantInventoryVariables,
          });
          logger("info", "Successfully fetched the inventory for the variants");
        } catch (e) {
          logger(
            "error",
            `[update-box-inventory-using-box] Could not get the  default variant inventory id`,
            e,
          );
          throw new Error(e);
        }
        try {
          const inventoryAdjustQuantitiesVariables = {
            input: {
              reason: "correction",
              name: "available",
              changes: inventoryUpdateObjs,
            },
          };
          await executeShopifyQueries({
            accessToken,
            callback: null,
            query: INVENTORY_ADJUST_QUANTITIES,
            storeUrl,
            variables: inventoryAdjustQuantitiesVariables,
          });
          logger(
            "info",
            "Successfully updated inventory for the default variant",
          );
        } catch (e) {
          logger(
            "error",
            `[migrate-bundles-marketplace[create-store-product]] Could adjust the inventory quantities`,
            e,
          );
          throw new Error(e);
        }
      }
    }),
  );
};

export const deductInventory = async ({ storeId, boxId, delta }) => {
  try {
    const storeBoxInventory = await StoreBoxes.findOne({
      store: storeId,
    });
    // const shopifyPackagingProduct
    const newStoreBoxInventory = storeBoxInventory.inventory.map((inv) => {
      const isInventoryUpdated = inv.box.toString() === boxId.toString();
      if (isInventoryUpdated) {
        inv.used = inv.used + Number(delta);
        inv.remaining = inv.remaining - Number(delta);
      }
      return inv;
    });
    await StoreBoxes.findByIdAndUpdate(storeBoxInventory._id, {
      inventory: newStoreBoxInventory,
    });
    logger("info", "Successfully updated the store inventory");
  } catch (error) {
    logger("error", "[deduct-inventory] Error updating store inventory", error);
  }
};
