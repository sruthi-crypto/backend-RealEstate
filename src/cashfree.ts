// ============================================================
// Cashfree Payment Provider
// Implements the PaymentProvider interface for Cashfree.
// To add Razorpay/PayU later: create razorpay.ts / payu.ts
// with the same exported function signatures.
// ============================================================

export type CashfreeEnv = {
	CASHFREE_CLIENT_ID: string;
	CASHFREE_CLIENT_SECRET: string;
	CASHFREE_ENVIRONMENT: string; // "sandbox" | "production"
};

export type CashfreeOrderResult = {
	cf_order_id: string;
	payment_session_id: string;
	payment_link: string;
};

function cfBaseUrl(env: CashfreeEnv): string {
	return env.CASHFREE_ENVIRONMENT === "production"
		? "https://api.cashfree.com/pg"
		: "https://sandbox.cashfree.com/pg";
}

// Create a Cashfree order and return the payment session + link
export async function createCashfreeOrder(
	env: CashfreeEnv,
	params: {
		orderId: string;
		amountPaise: number;
		customerName: string;
		customerId: string;
		customerPhone: string;
		returnUrl: string;
	}
): Promise<CashfreeOrderResult> {
	const amountRupees = (params.amountPaise / 100).toFixed(2);
	// Cashfree requires: customer_name min 3 chars, no special chars
	const safeName = params.customerName
		.replace(/[^a-zA-Z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 50) || "User";
	const customerName = safeName.length >= 3 ? safeName : `User ${params.customerId.slice(-6)}`;
	const body = {
		order_id: params.orderId,
		order_amount: parseFloat(amountRupees),
		order_currency: "INR",
		customer_details: {
			customer_id: params.customerId,
			customer_name: customerName,
			customer_phone: params.customerPhone,
		},
		order_meta: {
			return_url: params.returnUrl,
		},
	};

	const res = await fetch(`${cfBaseUrl(env)}/orders`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-client-id": env.CASHFREE_CLIENT_ID,
			"x-client-secret": env.CASHFREE_CLIENT_SECRET,
			"x-api-version": "2023-08-01",
		},
		body: JSON.stringify(body),
	});

	const data = await res.json() as Record<string, unknown>;

	if (!res.ok) {
		const msg = (data.message as string) || JSON.stringify(data);
		throw new Error(`Cashfree order creation failed: ${msg}`);
	}

	const cfOrderId = data.cf_order_id as string;
	const sessionId = data.payment_session_id as string;

	return { cf_order_id: cfOrderId, payment_session_id: sessionId, payment_link: sessionId };
}

// Verify Cashfree webhook signature using HMAC-SHA256
export async function verifyCashfreeWebhook(
	secret: string,
	rawBody: string,
	timestamp: string,
	signature: string
): Promise<boolean> {
	try {
		const message = timestamp + rawBody;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"]
		);
		const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
		const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
		return computed === signature;
	} catch {
		return false;
	}
}

// Fetch payment status from Cashfree for a given order
export async function getCashfreePaymentStatus(
	env: CashfreeEnv,
	cfOrderId: string
): Promise<{ status: string; cf_payment_id: string; amount: number } | null> {
	const res = await fetch(`${cfBaseUrl(env)}/orders/${cfOrderId}/payments`, {
		headers: {
			"x-client-id": env.CASHFREE_CLIENT_ID,
			"x-client-secret": env.CASHFREE_CLIENT_SECRET,
			"x-api-version": "2023-08-01",
		},
	});
	if (!res.ok) return null;
	const data = await res.json() as Record<string, unknown>[];
	if (!Array.isArray(data) || data.length === 0) return null;
	const p = data[0] as Record<string, unknown>;
	return {
		status: (p.payment_status as string) || "UNKNOWN",
		cf_payment_id: String(p.cf_payment_id || ""),
		amount: Number(p.order_amount || 0),
	};
}