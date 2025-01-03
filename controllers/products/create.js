import logger from "#common-functions/logger/index.js";
import executeShopifyQueries from "#common-functions/shopify/execute.js";
import { GET_PRODUCT_DETAILS } from "#common-functions/shopify/queries.js";
import Products from "#schemas/products.js";
import Stores from "#schemas/stores.js";

export default async function ProductCreateEventHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[product-create-event-handler] Processing product: ${JSON.stringify(metadata["X-Shopify-Product-Id"])}`,
    );

    const storeUrl = metadata["X-Shopify-Shop-Domain"];

    const [store] = await Stores.find({
      storeUrl,
      isActive: true,
    }).lean();

    if (!store) {
      logger(
        "error",
        `[product-processing-lambda] Store not found ${storeUrl}`,
      );
      return;
    }
    const productId = payload.admin_graphql_api_id;
    let productDetails;
    try {
      productDetails = await executeShopifyQueries({
        accessToken: store.accessToken,
        storeUrl: store.storeUrl,
        query: GET_PRODUCT_DETAILS,
        variables: {
          id: productId,
        },
        callback: (result) => {
          const product = result?.data?.product;
          return {
            id: product.id,
            title: product.title,
            description: product.description,
            bodyHtml: product.bodyHtml,
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
            handle: product.handle,
            vendor: product.vendor,
            productType: product.productType,
            tags: product.tags,
            totalInventory: product.totalInventory,
            totalVariants: product.totalVariants,
            onlineStoreUrl: product.onlineStoreUrl,
            images: product.images.edges.map(({ node }) => ({
              src: node.src,
              altText: node.altText || null,
            })),
            variants: product.variants.edges.map(({ node }) => ({
              id: node.id,
              title: node.title,
              price: node.price,
              sku: node.sku,
              inventoryQuantity: node.inventoryQuantity || 0,
            })),
            metafields: product.metafields.edges.map(({ node }) => {
              return {
                id: node.id,
                namespace: node.namespace,
                key: node.key,
                value: node.value,
                description: node.value,
              };
            }),
          };
        },
      });
      logger("info", "Successfully fetched the product details");
    } catch (e) {
      logger(
        "error",
        "[product-create-handler] could not fetch the product details",
      );
      return;
    }

    let totalInventory = 0;
    if (productDetails?.variants?.length) {
      productDetails.variants.forEach((v) => {
        totalInventory += v.inventoryQuantity;
      });
    }
    const product = new Products({
      bodyHtml: productDetails.bodyHtml,
      createdAt: productDetails.createdAt,
      customProductType: productDetails.customProductType,
      description: productDetails.description,
      descriptionHtml: productDetails.descriptionHtml,
      handle: productDetails.handle,
      images: productDetails.images,
      onlineStoreUrl: productDetails.onlineStoreUrl,
      productId,
      tags: productDetails.tags,
      vendor: productDetails.vendor,
      store: store._id,
      title: productDetails.title,
      variants: productDetails.variants,
      updatedAt: productDetails.updatedAt,
      totalVariants: productDetails.variants?.length,
      totalInventory,
      productType: productDetails.productType,
    });
    await product.save();
  } catch (error) {
    logger("error", `[product-create-event-handler] Error: ${error.message}`);
  }
}
