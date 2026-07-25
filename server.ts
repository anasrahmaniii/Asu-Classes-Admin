import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory setup or other backend helpers can go here if needed in the future.

// API: Create Cashfree Order
app.post("/api/cashfree/create-order", async (req: any, res: any) => {
    try {
        const { courseId, userId, price, customerName, customerPhone, customerEmail } = req.body;

        if (!courseId || !userId || !price) {
            return res.status(400).json({ error: "Missing required fields (courseId, userId, price)" });
        }

        // Cashfree Environment Configuration
        const cfEnv = process.env.CASHFREE_ENV || "TEST"; // TEST for sandbox, PROD for production
        const cfUrl = cfEnv === "PROD" 
            ? "https://api.cashfree.com/pg/orders"
            : "https://sandbox.cashfree.com/pg/orders";

        // Secret Credentials (Fallback to test credentials if not present in env)
        const cfAppId = process.env.CASHFREE_CLIENT_ID || "TEST1032840428d095908b8b0908861140482301";
        const cfSecret = process.env.CASHFREE_CLIENT_SECRET || "cfsecret_abc123demo";

        const orderId = `order_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const payload = {
            order_id: orderId,
            order_amount: price,
            order_currency: "INR",
            customer_details: {
                customer_id: userId,
                customer_name: customerName || "Student",
                customer_email: customerEmail || "student@example.com",
                customer_phone: customerPhone || "9999999999"
            },
            order_meta: {
                // Friendly return URL passing course_id and order_id back to index.html
                return_url: `http://localhost:3000/?order_id=${orderId}&course_id=${courseId}`,
                notify_url: `https://example.com/webhook` // Standard placeholder webhook
            },
            order_note: `Course ID: ${courseId}`
        };

        const response = await fetch(cfUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-client-id": cfAppId,
                "x-client-secret": cfSecret,
                "x-api-version": "2023-08-01"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("Cashfree API Order Creation Failed:", errText);
            return res.status(response.status).json({ error: `Cashfree API returned ${response.status}`, details: errText });
        }

        const data = await response.json();
        res.json({
            order_id: data.order_id,
            payment_session_id: data.payment_session_id,
            order_status: data.order_status
        });

    } catch (err: any) {
        console.error("Create Order Server Error:", err);
        res.status(500).json({ error: err.message || "Internal Server Error" });
    }
});

// API: Get Order Status & Auto Unlock Course in RTDB
app.get("/api/cashfree/order-status/:orderId", async (req: any, res: any) => {
    try {
        const { orderId } = req.params;

        const cfEnv = process.env.CASHFREE_ENV || "TEST";
        const cfUrl = cfEnv === "PROD"
            ? `https://api.cashfree.com/pg/orders/${orderId}`
            : `https://sandbox.cashfree.com/pg/orders/${orderId}`;

        const cfAppId = process.env.CASHFREE_CLIENT_ID || "TEST1032840428d095908b8b0908861140482301";
        const cfSecret = process.env.CASHFREE_CLIENT_SECRET || "cfsecret_abc123demo";

        const response = await fetch(cfUrl, {
            method: "GET",
            headers: {
                "x-client-id": cfAppId,
                "x-client-secret": cfSecret,
                "x-api-version": "2023-08-01"
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("Cashfree Order Status Retrieval Failed:", errText);
            return res.status(response.status).json({ error: `Cashfree Status check returned ${response.status}` });
        }

        const data = await response.json();
        const orderStatus = data.order_status; // e.g. "PAID", "ACTIVE"

        if (orderStatus === "PAID" || orderStatus === "SUCCESS") {
            // Unpack metadata or extract details
            const userId = data.customer_details?.customer_id;
            const orderNote = data.order_note || "";
            const courseIdMatch = orderNote.match(/Course ID: (.+)$/);
            const courseId = courseIdMatch ? courseIdMatch[1] : null;

            if (userId && courseId) {
                console.log(`Auto unlocking course ${courseId} for user ${userId} in Firebase Realtime Database...`);
                // Call Firebase REST API to unlock
                const dbUrl = `https://eos-classes-ff351-default-rtdb.firebaseio.com/users/${userId}/purchased/${courseId}.json`;
                await fetch(dbUrl, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(true)
                });
            }
        }

        res.json({
            order_id: data.order_id,
            order_status: orderStatus,
            order_amount: data.order_amount
        });

    } catch (err: any) {
        console.error("Order Status Server Error:", err);
        res.status(500).json({ error: err.message || "Internal Server Error" });
    }
});

// Vite Middleware & Static Assets Serving
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
        app.get("*", (req: any, res: any) => {
            res.sendFile(path.join(distPath, "index.html"));
        });
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server successfully started on http://localhost:${PORT}`);
    });
}

startServer();
