import logger from "#common-functions/logger/index.js";
import Orders from "#schemas/orders.js";

export default async function OrderCreateEventHandler(payload, metadata) {
  try {
    logger(
      "info",
      `[order-create-event-handler] Processing order: ${JSON.stringify(metadata["X-Shopify-Order-Id"])}`,
    );

    const orderId = metadata["X-Shopify-Order-Id"];
    const storeUrl = metadata["X-Shopify-Shop-Domain"];

    // Check if order already exists

    const existingOrder = await Orders.findOne({ orderId });

    if (existingOrder) {
      logger(
        "info",
        `[order-create-event-handler] Order already exists: ${orderId}`,
      );
      return;
    }

    const {
      name,
      total_price: totalPrice,
      total_tax: totalTax,
      total_discounts: totalDiscounts,
      discount_applications: discountApplications,
      financial_status: financialStatus,
      shipping_address: shippingAddress,
      client_details: clientDetails,
      billing_address: billingAddress,
      fulfillment_status: fulfillmentStatus,
      cancel_reason: cancelReason,
      cancelled_at: cancelledAt,
      order_status_url: orderStatusUrl,
      line_items: lineItems,
      note,
      payment_gateway_names: paymentGatewayNames,
    } = payload;

    const { phone, address1, address2, city, zip, province, country } =
      shippingAddress;

    const { browser_ip: browserIp } = clientDetails;

    const {
      address1: billingAddress1,
      address2: billingAddress2,
      city: billingCity,
      zip: billingZip,
      province: billingProvince,
      country: billingCountry,
    } = billingAddress;
    // Create order

    const newOrder = new Orders({
      orderId,
      orderName: name,
      totalPrice,
      totalDiscount: totalDiscounts,
      totalTax,
      discountCodes: discountApplications,
      financialStatus,
      phone,
      browserIp,
      shippingAddress: {
        address: `${address1} ${address2}`,
        city,
        state: province,
        country,
        zip,
      },
      billingAddress: {
        address: `${billingAddress1} ${billingAddress2}`,
        city: billingCity,
        state: billingProvince,
        country: billingCountry,
        zip: billingZip,
      },
      paymentGatewayName: paymentGatewayNames[0],
      fulfilled: fulfillmentStatus === "fulfilled",
      cancelled: cancelledAt !== null,
      cancelReason,
      storeUrl,
      orderStatusUrl,
      lineItems: lineItems.map((item) => ({
        variantId: item.variant_id,
        quantity: item.quantity,
        productId: item.product_id,
        sku: item.sku,
        title: item.title,
        totalDiscount: item.total_discount,
        taxLines: item.tax_lines,
        variantTitle: item.variant_title,
        totalPrice: item.price,
      })),
      note,
    });

    await newOrder.save();

    logger("info", `[order-create-event-handler] Order created: ${orderId}`);
  } catch (error) {
    logger("error", `[order-create-event-handler] Error: ${error.message}`);
  }
}
