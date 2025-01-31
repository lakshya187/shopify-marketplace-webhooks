import logger from "#common-functions/logger/index.js";
import Bundles from "#schemas/bundles.js";
import Coupons from "#schemas/coupons.js";
import Products from "#schemas/products.js";
import StoreBoxes from "#schemas/storeBoxes.js";
import storeBoxOrders from "#schemas/storeBoxOrders.js";
import Stores from "#schemas/stores.js";
import { DeleteBundles, DeleteCoupon } from "../../helpers/apps/index.js";

export const AppUninstallEventHandler = async (event) => {
  try {
    const { myshopify_domain: storeUrl } = event;

    const store = await Stores.findOne({ storeUrl }).lean();

    const marketplace = await Stores.findOne({
      isActive: true,
      isInternalStore: true,
    }).lean();

    const storeBundles = await Bundles.find({
      isDeleted: false,
      store: store._id,
      isTemp: false,
    }).lean();

    const storeCoupons = await Coupons.find({
      store: store._id,
    });

    for (const bundle of storeBundles) {
      await DeleteBundles({
        bundle: bundle,
        marketPlace: {
          accessToken: marketplace.accessToken,
          storeUrl: marketplace.storeUrl,
        },
        store: {
          accessToken: store.accessToken,
          storeUrl: store.storeUrl,
        },
      });
    }

    for (const coupon of storeCoupons) {
      await DeleteCoupon({
        accessToken: marketplace.accessToken,
        storeUrl: marketplace.storeUrl,
        coupon,
      });
    }

    await Products.deleteMany({
      store: store._id,
    });

    await StoreBoxes.deleteMany({
      store: store._id,
    });

    await storeBoxOrders.deleteMany({
      store: store._id,
    });

    await Stores.findByIdAndUpdate(store._id, {
      isActive: false,
    });

    return {
      status: 200,
      message: "Successfully handled the app uninstall event",
    };
  } catch (e) {
    logger(
      "error",
      "[app-uninstall-handler] Error when running app uninstall event handler",
      e,
    );
  }
};
