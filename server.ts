import express from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Capture raw body for Cashfree Webhook Signature Verification if needed
app.use(express.json({
    verify: (req: any, _res, buf) => {
        req.rawBody = buf;
    }
}));

const FIREBASE_DB_URL = "https://eos-classes-ff351-default-rtdb.firebaseio.com";

// --- Firebase REST Helper Functions ---
async function fbGet(pathStr: string) {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/${pathStr}.json`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error(`Firebase GET error at ${pathStr}:`, err);
        return null;
    }
}

async function fbPut(pathStr: string, data: any) {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/${pathStr}.json`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        return res.ok;
    } catch (err) {
        console.error(`Firebase PUT error at ${pathStr}:`, err);
        return false;
    }
}

async function fbPatch(pathStr: string, data: any) {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/${pathStr}.json`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        return res.ok;
    } catch (err) {
        console.error(`Firebase PATCH error at ${pathStr}:`, err);
        return false;
    }
}

async function fbPost(pathStr: string, data: any) {
    try {
        const res = await fetch(`${FIREBASE_DB_URL}/${pathStr}.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.error(`Firebase POST error at ${pathStr}:`, err);
        return null;
    }
}

// Helper to format currency
function formatINR(num: number) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(num);
}

// Cashfree Environment Helpers
async function getCashfreeConfig() {
    let dbSettings: any = null;
    try {
        dbSettings = await fbGet("settings/cashfree");
    } catch(e) {
        console.warn("Could not read DB cashfree settings:", e);
    }

    const appId = (dbSettings && dbSettings.appId) ? dbSettings.appId.trim() : (process.env.CASHFREE_CLIENT_ID || "TEST1032840428d095908b8b0908861140482301");
    const secretKey = (dbSettings && dbSettings.secretKey) ? dbSettings.secretKey.trim() : (process.env.CASHFREE_CLIENT_SECRET || "cfsecret_abc123demo");
    const rawEnv = (dbSettings && dbSettings.env) ? dbSettings.env : (process.env.CASHFREE_ENV || "TEST");
    const cfEnv = rawEnv.toUpperCase() === "PROD" || rawEnv.toUpperCase() === "PRODUCTION" ? "PROD" : "TEST";
    const webhookSecret = (dbSettings && dbSettings.webhookSecret) ? dbSettings.webhookSecret.trim() : (process.env.CASHFREE_WEBHOOK_SECRET || secretKey);

    return {
        cfEnv,
        baseUrl: cfEnv === "PROD" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg",
        appId,
        secretKey,
        webhookSecret
    };
}

// Helper: Verify and Fulfill Course Order Idempotently
async function fulfillOrder(orderId: string, paymentDetails: any = {}) {
    console.log(`[Order Fulfillment] Processing order: ${orderId}`);
    const orderRecord = await fbGet(`payment_orders/${orderId}`);

    if (!orderRecord) {
        console.warn(`[Order Fulfillment] Order ${orderId} not found in database.`);
        return { success: false, reason: "ORDER_NOT_FOUND" };
    }

    // Idempotency check: If already paid and processed, skip duplicate work
    if (orderRecord.status === "PAID" && orderRecord.autoApproved) {
        console.log(`[Order Fulfillment] Order ${orderId} is already fulfilled.`);
        return { success: true, alreadyProcessed: true, orderRecord };
    }

    const { userId, courseId, courseTitle, amount, customerName, customerEmail, customerPhone } = orderRecord;
    const now = Date.now();
    const invoiceNum = orderRecord.invoiceNumber || `INV-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
    const transactionId = paymentDetails.cf_payment_id || paymentDetails.transaction_id || `CF_TXN_${Date.now()}`;
    const paymentMethod = paymentDetails.payment_group || paymentDetails.payment_method || "Cashfree PG";

    // 1. Mark Order as PAID
    await fbPatch(`payment_orders/${orderId}`, {
        status: "PAID",
        paymentStatus: "SUCCESS",
        verifiedAt: now,
        transactionId,
        cashfreePaymentId: paymentDetails.cf_payment_id || orderId,
        paymentMethod,
        invoiceNumber: invoiceNum,
        autoApproved: true
    });

    // 2. Unlock Course in User's Purchased Map
    if (userId && courseId) {
        await fbPut(`users/${userId}/purchased/${courseId}`, true);

        // 3. Create Enrollment Record
        await fbPut(`enrollments/${userId}_${courseId}`, {
            userId,
            courseId,
            courseTitle: courseTitle || "Purchased Course",
            enrolledAt: now,
            accessStatus: "ACTIVE",
            accessType: "LIFETIME",
            purchaseSource: "Cashfree Payment Gateway",
            paymentId: orderId,
            transactionId,
            amount,
            invoiceNumber: invoiceNum
        });

        // 4. Create backward-compatible entry in payment_requests
        await fbPut(`payment_requests/${orderId}`, {
            courseId,
            courseName: courseTitle || "Purchased Course",
            amount,
            userId,
            userName: customerName || "Student",
            userPhone: customerPhone || "N/A",
            txnId: transactionId,
            status: "Approved",
            time: now,
            autoApproved: true,
            invoiceNumber: invoiceNum
        });

        // 5. Generate Official Invoice Record
        await fbPut(`invoices/${orderId}`, {
            invoiceNumber: invoiceNum,
            orderId,
            transactionId,
            userId,
            customerName: customerName || "Student",
            customerEmail: customerEmail || "student@example.com",
            customerPhone: customerPhone || "N/A",
            courseId,
            courseTitle: courseTitle || "Purchased Course",
            amount,
            currency: "INR",
            paymentMethod,
            issuedAt: now,
            status: "PAID",
            taxRate: 0, // Inclusive tax
            gstAmount: 0
        });

        // 6. Push In-App Alert Notification to User
        await fbPost(`notifications`, {
            title: "🎉 Course Activated Successfully!",
            message: `Payment of ${formatINR(amount)} verified. You now have lifetime access to "${courseTitle}". Invoice: ${invoiceNum}`,
            time: now,
            category: "Enrollment",
            userId: userId,
            webPush: true
        });

        console.log(`[Order Fulfillment] SUCCESS: Course ${courseId} unlocked for User ${userId}. Invoice: ${invoiceNum}`);
    }

    const updatedOrder = await fbGet(`payment_orders/${orderId}`);
    return { success: true, alreadyProcessed: false, orderRecord: updatedOrder };
}

// -----------------------------------------------------------------------------
// API ENDPOINTS
// -----------------------------------------------------------------------------

// 1. CREATE CASHFREE ORDER
app.post("/api/cashfree/create-order", async (req: any, res: any) => {
    try {
        const { courseId, courseTitle, userId, price, customerName, customerPhone, customerEmail, productType } = req.body;

        if (!courseId || !userId || price === undefined || price === null) {
            return res.status(400).json({ error: "Missing required fields (courseId, userId, price)" });
        }

        const numericPrice = parseFloat(price);
        if (isNaN(numericPrice) || numericPrice <= 0) {
            return res.status(400).json({ error: "Invalid price specified." });
        }

        // --- DUPLICATE PURCHASE CHECK ---
        const userPurchased = await fbGet(`users/${userId}/purchased/${courseId}`);
        if (userPurchased) {
            return res.status(400).json({
                error: "ALREADY_OWNED",
                message: "You already own this course or product!"
            });
        }

        const { cfEnv, baseUrl, appId, secretKey } = await getCashfreeConfig();

        // Unique Order ID
        const orderId = `cf_order_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

        // Build return URL
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
        const returnUrl = `${protocol}://${host}/?order_id=${orderId}&course_id=${courseId}&cf_status={param_placeholder_from_cashfree}`;
        const notifyUrl = `${protocol}://${host}/api/cashfree/webhook`;

        const payload = {
            order_id: orderId,
            order_amount: numericPrice,
            order_currency: "INR",
            customer_details: {
                customer_id: userId.replace(/[^a-zA-Z0-9_-]/g, "_"),
                customer_name: (customerName || "Student").trim(),
                customer_email: (customerEmail && customerEmail.includes("@")) ? customerEmail.trim() : "student@asuclasses.com",
                customer_phone: (customerPhone && customerPhone.length >= 10) ? customerPhone.replace(/\D/g, "").slice(-10) : "9999999999"
            },
            order_meta: {
                return_url: returnUrl,
                notify_url: notifyUrl
            },
            order_note: `Course: ${courseTitle || courseId}`
        };

        const response = await fetch(`${baseUrl}/orders`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-client-id": appId,
                "x-client-secret": secretKey,
                "x-api-version": "2023-08-01"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("[Cashfree Create Order Failed]:", response.status, errText);
            return res.status(response.status).json({
                error: "CASHFREE_API_ERROR",
                message: `Failed to create Cashfree order (HTTP ${response.status})`,
                details: errText
            });
        }

        const cfData = await response.json();

        // Save Order Details in DB as PENDING
        const newOrderRecord = {
            orderId: cfData.order_id,
            paymentSessionId: cfData.payment_session_id,
            userId,
            courseId,
            courseTitle: courseTitle || "Course #" + courseId,
            productType: productType || "course",
            amount: numericPrice,
            currency: "INR",
            customerName: customerName || "Student",
            customerEmail: customerEmail || "N/A",
            customerPhone: customerPhone || "N/A",
            status: "PENDING",
            paymentStatus: "PENDING",
            createdAt: Date.now(),
            cfEnv,
            autoApproved: false
        };

        await fbPut(`payment_orders/${orderId}`, newOrderRecord);

        res.json({
            success: true,
            order_id: cfData.order_id,
            payment_session_id: cfData.payment_session_id,
            order_status: cfData.order_status,
            cf_env: cfEnv
        });

    } catch (err: any) {
        console.error("Create Order Exception:", err);
        res.status(500).json({ error: "INTERNAL_ERROR", message: err.message || "Server Error" });
    }
});

// 2. VERIFY CASHFREE ORDER (Server-to-Server Verification)
app.get("/api/cashfree/verify-order/:orderId", async (req: any, res: any) => {
    try {
        const { orderId } = req.params;
        if (!orderId) return res.status(400).json({ error: "Order ID is required." });

        const { baseUrl, appId, secretKey } = await getCashfreeConfig();

        // 1. Query Cashfree REST API for Order Details
        const orderRes = await fetch(`${baseUrl}/orders/${orderId}`, {
            method: "GET",
            headers: {
                "x-client-id": appId,
                "x-client-secret": secretKey,
                "x-api-version": "2023-08-01"
            }
        });

        if (!orderRes.ok) {
            const errText = await orderRes.text();
            console.error(`[Verify Order] Cashfree returned ${orderRes.status}:`, errText);
            return res.status(orderRes.status).json({ error: "CASHFREE_FETCH_FAILED", message: "Unable to verify order with Cashfree." });
        }

        const orderData = await orderRes.json();
        const cfOrderStatus = orderData.order_status; // "PAID", "ACTIVE", "EXPIRED", "CANCELLED"

        // 2. Fetch Payment Transactions from Cashfree
        let paymentDetails: any = {};
        try {
            const paymentsRes = await fetch(`${baseUrl}/orders/${orderId}/payments`, {
                headers: {
                    "x-client-id": appId,
                    "x-client-secret": secretKey,
                    "x-api-version": "2023-08-01"
                }
            });
            if (paymentsRes.ok) {
                const paymentsList = await paymentsRes.json();
                if (Array.isArray(paymentsList) && paymentsList.length > 0) {
                    // Pick the last successful payment if present
                    const successPayment = paymentsList.find((p: any) => p.payment_status === "SUCCESS") || paymentsList[0];
                    paymentDetails = successPayment;
                }
            }
        } catch (e) {
            console.warn("Error fetching detailed payments list from Cashfree:", e);
        }

        // 3. Handle Status
        if (cfOrderStatus === "PAID" || paymentDetails.payment_status === "SUCCESS") {
            const result = await fulfillOrder(orderId, paymentDetails);
            return res.json({
                verified: true,
                order_status: "PAID",
                payment_status: "SUCCESS",
                message: "Payment successfully verified and course activated!",
                invoice_number: result.orderRecord?.invoiceNumber,
                orderRecord: result.orderRecord
            });
        } else {
            // Update order status in DB to FAILED or CANCELLED if expired
            await fbPatch(`payment_orders/${orderId}`, {
                status: cfOrderStatus,
                paymentStatus: cfOrderStatus === "EXPIRED" ? "EXPIRED" : "FAILED",
                lastCheckedAt: Date.now()
            });

            return res.json({
                verified: false,
                order_status: cfOrderStatus,
                payment_status: "FAILED",
                message: `Payment is ${cfOrderStatus}. Course not activated.`
            });
        }

    } catch (err: any) {
        console.error("Verify Order Exception:", err);
        res.status(500).json({ error: "VERIFICATION_ERROR", message: err.message || "Server Error" });
    }
});

// 3. CASHFREE WEBHOOK LISTENER
app.post("/api/cashfree/webhook", async (req: any, res: any) => {
    try {
        console.log("=== [Cashfree Webhook Received] ===");
        const { webhookSecret } = await getCashfreeConfig();

        // Webhook signature validation if secret & header provided
        const signatureHeader = req.headers['x-webhook-signature'];
        const timestampHeader = req.headers['x-webhook-timestamp'];

        if (webhookSecret && signatureHeader && timestampHeader && req.rawBody) {
            try {
                const payloadToSign = timestampHeader + req.rawBody.toString('utf8');
                const computedSignature = crypto.createHmac('sha256', webhookSecret).update(payloadToSign).digest('base64');
                if (computedSignature !== signatureHeader) {
                    console.warn("[Cashfree Webhook] Invalid Webhook Signature! Rejecting event.");
                    return res.status(400).send("Invalid Webhook Signature");
                }
            } catch (sigErr) {
                console.warn("[Cashfree Webhook] Signature verification failed:", sigErr);
            }
        }

        const body = req.body || {};
        const eventType = body.type || body.event || "UNKNOWN";
        const data = body.data || {};
        const orderId = data.order?.order_id || data.order_id || body.order_id;

        console.log(`[Webhook Event]: ${eventType} for Order: ${orderId}`);

        // Log Webhook Event in DB
        const webhookLogId = `wh_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        await fbPut(`webhook_logs/${webhookLogId}`, {
            id: webhookLogId,
            orderId,
            eventType,
            payload: body,
            receivedAt: Date.now()
        });

        if (orderId && (eventType === "PAYMENT_SUCCESS_WEBHOOK" || eventType === "ORDER_PAID" || data.payment?.payment_status === "SUCCESS")) {
            const paymentObj = data.payment || {};
            await fulfillOrder(orderId, paymentObj);
        }

        // Return 200 OK to Cashfree
        res.status(200).json({ status: "OK", received: true });

    } catch (err: any) {
        console.error("[Cashfree Webhook Error]:", err);
        res.status(500).json({ error: "WEBHOOK_PROCESSING_FAILED", details: err.message });
    }
});

// 4. GENERATE PRINTABLE/DOWNLOADABLE INVOICE HTML
app.get("/api/cashfree/invoice/:orderId", async (req: any, res: any) => {
    try {
        const { orderId } = req.params;
        const invoiceData = await fbGet(`invoices/${orderId}`) || await fbGet(`payment_orders/${orderId}`);

        if (!invoiceData) {
            return res.status(404).send("<h2 style='text-align:center;font-family:sans-serif;margin-top:50px;'>Invoice not found.</h2>");
        }

        const invNum = invoiceData.invoiceNumber || `INV-${orderId}`;
        const issueDate = new Date(invoiceData.issuedAt || invoiceData.createdAt || Date.now()).toLocaleDateString('en-IN', {
            year: 'numeric', month: 'long', day: 'numeric'
        });

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tax Invoice - ${invNum}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                @media print {
                    .no-print { display: none !important; }
                    body { background: white !important; color: black !important; padding: 0 !important; }
                    .invoice-box { border: none !important; shadow: none !important; }
                }
            </style>
        </head>
        <body class="bg-slate-100 min-h-screen py-10 px-4 font-sans text-slate-800">
            <div class="max-w-3xl mx-auto mb-6 flex justify-between items-center no-print">
                <a href="/" class="text-xs font-bold text-indigo-600 hover:underline flex items-center gap-1">
                    <i class="fa-solid fa-arrow-left"></i> Return to Website
                </a>
                <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs uppercase px-5 py-2.5 rounded-xl shadow-lg flex items-center gap-2 transition-all">
                    <i class="fa-solid fa-print"></i> Download / Print PDF
                </button>
            </div>

            <div class="invoice-box max-w-3xl mx-auto bg-white rounded-3xl p-8 sm:p-12 shadow-xl border border-slate-200">
                <!-- Header -->
                <div class="flex justify-between items-start border-b border-slate-200 pb-8">
                    <div>
                        <div class="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center text-white font-black text-xl mb-3 shadow-md">
                            ASU
                        </div>
                        <h1 class="text-2xl font-black text-slate-900 tracking-tight">ASU CLASSES</h1>
                        <p class="text-xs text-slate-500 font-medium mt-1">Empowering Education Everywhere</p>
                    </div>
                    <div class="text-right">
                        <span class="inline-block bg-emerald-100 text-emerald-800 font-black text-[10px] uppercase tracking-widest px-3 py-1 rounded-full mb-3">
                            <i class="fa-solid fa-circle-check mr-1"></i> PAID
                        </span>
                        <h2 class="text-xl font-black text-slate-800">TAX INVOICE</h2>
                        <p class="text-xs font-bold text-slate-500 mt-1"># ${invNum}</p>
                        <p class="text-[11px] text-slate-400 font-medium mt-0.5">Date: ${issueDate}</p>
                    </div>
                </div>

                <!-- Billed To / Payment Method -->
                <div class="grid grid-cols-2 gap-6 py-8 border-b border-slate-100">
                    <div>
                        <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">BILLED TO (STUDENT)</p>
                        <p class="text-sm font-black text-slate-800">${invoiceData.customerName || 'Student'}</p>
                        <p class="text-xs text-slate-600 font-medium mt-0.5">${invoiceData.customerEmail || ''}</p>
                        <p class="text-xs text-slate-600 font-medium mt-0.5">Phone: ${invoiceData.customerPhone || 'N/A'}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">PAYMENT INFORMATION</p>
                        <p class="text-xs font-bold text-slate-800">Gateway: <span class="text-indigo-600">Cashfree PG</span></p>
                        <p class="text-xs text-slate-600 mt-1">Txn ID: <code class="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">${invoiceData.transactionId || orderId}</code></p>
                        <p class="text-xs text-slate-600 mt-1">Order ID: <code class="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">${orderId}</code></p>
                    </div>
                </div>

                <!-- Order Items Table -->
                <div class="py-8">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="border-b border-slate-200">
                                <th class="py-3 text-[10px] font-black uppercase text-slate-400 tracking-wider">Item Description</th>
                                <th class="py-3 text-[10px] font-black uppercase text-slate-400 tracking-wider text-center">Type</th>
                                <th class="py-3 text-[10px] font-black uppercase text-slate-400 tracking-wider text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-100">
                            <tr>
                                <td class="py-4">
                                    <p class="font-black text-sm text-slate-800">${invoiceData.courseTitle || 'Purchased Course'}</p>
                                    <p class="text-[11px] text-slate-400 mt-0.5">Includes lifetime access, video lectures & downloadable study materials.</p>
                                </td>
                                <td class="py-4 text-center">
                                    <span class="text-[10px] font-bold bg-slate-100 px-2.5 py-1 rounded-md text-slate-600 uppercase">Course</span>
                                </td>
                                <td class="py-4 text-right font-black text-sm text-slate-900">
                                    ${formatINR(invoiceData.amount || 0)}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Totals -->
                <div class="border-t border-slate-200 pt-6 flex justify-end">
                    <div class="w-full sm:w-64 space-y-2">
                        <div class="flex justify-between text-xs text-slate-500 font-medium">
                            <span>Subtotal:</span>
                            <span>${formatINR(invoiceData.amount || 0)}</span>
                        </div>
                        <div class="flex justify-between text-xs text-slate-500 font-medium">
                            <span>Taxes (GST Incl.):</span>
                            <span>₹0.00</span>
                        </div>
                        <div class="flex justify-between text-base font-black text-slate-900 border-t border-slate-200 pt-3">
                            <span>Total Paid:</span>
                            <span class="text-indigo-600">${formatINR(invoiceData.amount || 0)}</span>
                        </div>
                    </div>
                </div>

                <!-- Footer -->
                <div class="mt-12 border-t border-slate-100 pt-8 text-center text-xs text-slate-400 font-medium leading-relaxed">
                    <p class="font-bold text-slate-600">Thank you for learning with ASU CLASSES!</p>
                    <p class="mt-1">This is a computer-generated tax invoice verified by Cashfree Payment Gateway.</p>
                </div>
            </div>
        </body>
        </html>
        `;

        res.send(html);

    } catch (err: any) {
        console.error("Invoice Error:", err);
        res.status(500).send("Error generating invoice");
    }
});

// 5. GET USER'S ORDER HISTORY
app.get("/api/cashfree/user-orders/:userId", async (req: any, res: any) => {
    try {
        const { userId } = req.params;
        const allOrders = await fbGet(`payment_orders`) || {};

        const userOrders = Object.values(allOrders).filter((o: any) => o && o.userId === userId);
        res.json({ success: true, orders: userOrders });
    } catch (err: any) {
        res.status(500).json({ error: "FETCH_FAILED", message: err.message });
    }
});

// 6. ADMIN ENDPOINTS: GET ALL PAYMENT ORDERS & WEBHOOK LOGS
app.get("/api/cashfree/admin/all-orders", async (_req: any, res: any) => {
    try {
        const ordersObj = await fbGet(`payment_orders`) || {};
        const requestsObj = await fbGet(`payment_requests`) || {};
        const invoicesObj = await fbGet(`invoices`) || {};

        res.json({
            success: true,
            payment_orders: ordersObj,
            payment_requests: requestsObj,
            invoices: invoicesObj
        });
    } catch (err: any) {
        res.status(500).json({ error: "ADMIN_FETCH_FAILED", message: err.message });
    }
});

app.get("/api/cashfree/admin/webhook-logs", async (_req: any, res: any) => {
    try {
        const logsObj = await fbGet(`webhook_logs`) || {};
        res.json({ success: true, webhook_logs: logsObj });
    } catch (err: any) {
        res.status(500).json({ error: "FETCH_FAILED", message: err.message });
    }
});


// -----------------------------------------------------------------------------
// VITE DEV / PRODUCTION SERVER BOOTSTRAP
// -----------------------------------------------------------------------------
async function startServer() {
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa"
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(process.cwd(), "dist");
        app.use(express.static(distPath));
        app.get("*", (_req: any, res: any) => {
            res.sendFile(path.join(distPath, "index.html"));
        });
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`⚡ Server running on http://0.0.0.0:${PORT}`);
    });
}

startServer();

export default app;
