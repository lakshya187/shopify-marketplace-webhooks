import executeShopifyQueries from "#common-functions/shopify/execute.js";
import {
  DELETE_COUPON,
  DELETE_PRODUCT,
} from "#common-functions/shopify/queries.js";
import Bundles from "#schemas/bundles.js";
import logger from "#common-functions/logger/index.js";
import Coupons from "#schemas/coupons.js";

export const DeleteBundles = async ({ bundle, store, marketPlace }) => {
  try {
    await executeShopifyQueries({
      query: DELETE_PRODUCT,
      storeUrl: marketPlace.storeUrl,
      accessToken: marketPlace.accessToken,
      variables: {
        productId: bundle.shopifyProductId,
      },
    });
  } catch (error) {
    logger(
      "error",
      "[delete-single-bundle] Error deleting product from marketPlace store",
      error,
    );
  }

  try {
    await executeShopifyQueries({
      query: DELETE_PRODUCT,
      storeUrl: store.storeUrl,
      accessToken: store.accessToken,
      variables: {
        productId: bundle.metadata.vendorShopifyId,
      },
    });
  } catch (error) {
    logger(
      "error",
      "[delete-single-bundle] Error deleting product from vendor store",
      error,
    );
  }
};

export const DeleteCoupon = async ({ coupon, accessToken, storeUrl }) => {
  try {
    await Promise.all([
      executeShopifyQueries({
        accessToken: accessToken,
        storeUrl: storeUrl,
        query: DELETE_COUPON,
        variables: {
          id: coupon.shopifyId,
        },
      }),
      Coupons.findByIdAndUpdate(coupon._id, {
        isDeleted: true,
      }),
    ]);
  } catch (e) {
    logger("error", "Error when deleting the coupons");
    throw e;
  }
};
