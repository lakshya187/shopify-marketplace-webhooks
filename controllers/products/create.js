import logger from "#common-functions/logger/index.js";
import GetSingleProduct from "#common-functions/shopify/getSingleProduct.js";
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
    const productDetails = await GetSingleProduct({
      accessToken: store.accessToken,
      productId,
      shopName: store.shopName,
      storeUrl: store.storeUrl,
    });
    if (!productDetails) {
      logger(
        "error",
        "Could not fetch the details of the newly created product",
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
