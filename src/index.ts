import { SignJWT, jwtVerify } from "jose";
import { authenticator } from "otplib";

const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization"
};

type Env = {
	SUPABASE_URL: string;
	SUPABASE_KEY: string;
	JWT_SECRET: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	BOT_USERNAME?: string;
	// ── Cashfree ticket bot ──
	CF_BOT_TOKEN?: string;           // Telegram bot token for the Cashfree ticket bot
	CF_BOT_USERNAME?: string;        // e.g. supremv_bot
	CASHFREE_CLIENT_ID?: string;
	CASHFREE_CLIENT_SECRET?: string;
	CASHFREE_ENVIRONMENT?: string;   // "sandbox" | "production"
	CASHFREE_WEBHOOK_SECRET?: string;
	API_BASE_URL?: string;           // public Worker URL, e.g. https://apis-realestate.workers.dev
	WEBSITE_URL?: string;            // public frontend URL for the Cashfree return page
	CONFIG_ENCRYPTION_KEY?: string;  // master key for encrypted admin-managed integration secrets
};

// ================= PASSWORD HASH =================

async function hashPassword(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return (await hashPassword(password)) === hash;
}

// ================= SUPABASE ERROR =================

class SupabaseRequestError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "SupabaseRequestError";
		this.status = status;
	}
}

// ================= RESPONSE HELPERS =================

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, "Content-Type": "application/json" }
	});
}

function successResponse(data: unknown, message = "Success", status = 200) {
	return new Response(JSON.stringify({ success: true, message, data }), {
		status,
		headers: { ...cors, "Content-Type": "application/json" }
	});
}

function errorResponse(message: string, status = 400) {
	return new Response(JSON.stringify({ success: false, message }), {
		status,
		headers: { ...cors, "Content-Type": "application/json" }
	});
}

// ================= AUTH =================

async function verifyAdmin(request: Request, env: Env) {
	const auth = request.headers.get("Authorization");
	if (!auth) return null;
	try {
		const token = auth.replace("Bearer ", "");
		const secret = new TextEncoder().encode(env.JWT_SECRET);
		const { payload } = await jwtVerify(token, secret);
		if (payload.role !== "admin" && payload.role !== "super_admin") return null;
		return payload;
	} catch {
		return null;
	}
}

// ================= SUPABASE CALL =================

async function callSupabase(env: Env, path: string, init?: RequestInit) {
	if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error("Supabase configuration missing");
	const res = await fetch(`${env.SUPABASE_URL}${path}`, {
		...init,
		headers: {
			apikey: env.SUPABASE_KEY,
			Authorization: `Bearer ${env.SUPABASE_KEY}`,
			...(init?.headers || {})
		}
	});
	if (res.status === 204) return null;
	const text = await res.text();
	if (!text) {
		if (!res.ok) throw new Error(`Supabase ${res.status} ${res.statusText}`);
		return null;
	}
	let data: unknown;
	try { data = JSON.parse(text); } catch {
		throw new Error(`Invalid JSON from Supabase (${res.status}): ${text.slice(0, 200)}`);
	}
	if (!res.ok) {
		const d = data as Record<string, unknown>;
		const msg = typeof d?.message === "string" ? d.message : typeof d?.msg === "string" ? d.msg : JSON.stringify(data);
		throw new SupabaseRequestError(`Supabase ${res.status}: ${msg}`, res.status);
	}
	return data;
}

async function configCryptoKey(env: Env): Promise<CryptoKey> {
	if (!env.CONFIG_ENCRYPTION_KEY) throw new Error("CONFIG_ENCRYPTION_KEY is not configured");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.CONFIG_ENCRYPTION_KEY));
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptConfigSecret(env: Env, value: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await configCryptoKey(env), new TextEncoder().encode(value));
	const bytes = new Uint8Array(encrypted);
	const encode = (input: Uint8Array) => btoa(String.fromCharCode(...input));
	return `${encode(iv)}.${encode(bytes)}`;
}

async function decryptConfigSecret(env: Env, value: string): Promise<string | null> {
	try {
		const [ivText, encryptedText] = value.split(".");
		const decode = (input: string) => Uint8Array.from(atob(input), char => char.charCodeAt(0));
		const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(ivText) }, await configCryptoKey(env), decode(encryptedText));
		return new TextDecoder().decode(decrypted);
	} catch { return null; }
}

async function getIntegrationSecret(env: Env, table: "payment_gateways" | "telegram_bots", key: string, name: string, fallback?: string): Promise<string | undefined> {
	try {
		const rows = await callSupabase(env, `/rest/v1/${table}?key=eq.${encodeURIComponent(key)}&select=encrypted_secrets`) as Record<string, unknown>[] | null;
		const secrets = rows?.[0]?.encrypted_secrets as Record<string, string> | undefined;
		const encrypted = secrets?.[name];
		if (encrypted) return (await decryptConfigSecret(env, encrypted)) || fallback;
	} catch { /* use deployment secret fallback */ }
	return fallback;
}

async function getActiveIntegrationKey(env: Env, field: "active_payment_key" | "active_telegram_key", fallback: string): Promise<string> {
	try {
		const rows = await callSupabase(env, "/rest/v1/flow_settings?id=eq.1&select=" + field) as Record<string, unknown>[] | null;
		return String(rows?.[0]?.[field] || fallback);
	} catch { return fallback; }
}

async function getCashfreeCredentials(env: Env) {
	const gatewayKey = await getActiveIntegrationKey(env, "active_payment_key", "cashfree");
	return {
		CASHFREE_CLIENT_ID: await getIntegrationSecret(env, "payment_gateways", gatewayKey, "CASHFREE_CLIENT_ID", env.CASHFREE_CLIENT_ID),
		CASHFREE_CLIENT_SECRET: await getIntegrationSecret(env, "payment_gateways", gatewayKey, "CASHFREE_CLIENT_SECRET", env.CASHFREE_CLIENT_SECRET),
		CASHFREE_WEBHOOK_SECRET: await getIntegrationSecret(env, "payment_gateways", gatewayKey, "CASHFREE_WEBHOOK_SECRET", env.CASHFREE_WEBHOOK_SECRET),
		CASHFREE_ENVIRONMENT: env.CASHFREE_ENVIRONMENT || "sandbox"
	};
}

async function getBody(request: Request) {
	try { return await request.json(); } catch { return null; }
}

// ================= TELEGRAM NOTIFY =================

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
	if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
	try {
		await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
		});
	} catch { /* silent */ }
}

// ================= USER AUTH (phone + password) =================

async function handleUserRegister(request: Request, env: Env): Promise<Response> {
	const body = (await getBody(request)) as Record<string, unknown> | null;
	if (!body) return errorResponse("Invalid or empty JSON body", 400);
	const phone = typeof body.phone === "string" ? body.phone.trim() : "";
	if (!phone) return errorResponse("Phone number required", 400);
	if (typeof body.password !== "string" || body.password.length < 6)
		return errorResponse("Password must be at least 6 characters", 400);

	console.info("[register] checking duplicate for phone ending", phone.slice(-4));
	let existing: unknown;
	try {
		existing = await callSupabase(env, `/rest/v1/users?phone=eq.${encodeURIComponent(phone)}&select=id`);
		console.info("[register] duplicate check result rows:", Array.isArray(existing) ? existing.length : existing);
	} catch (err: unknown) {
		console.error("[register] duplicate check failed:", (err as Error).message);
		throw err;
	}
	if (Array.isArray(existing) && existing.length > 0) return errorResponse("Phone number already registered", 409);

	const passwordHash = await hashPassword(body.password as string);
	console.info("[register] inserting user, phone ending", phone.slice(-4));
	let newUser: unknown;
	try {
		newUser = await callSupabase(env, "/rest/v1/users", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
			body: JSON.stringify({
				phone,
				password_hash: passwordHash,
				role: "user",
				location: body.location || null,
				is_active: true
			})
		});
		console.info("[register] insert result rows:", Array.isArray(newUser) ? newUser.length : typeof newUser);
	} catch (err: unknown) {
		console.error("[register] insert failed:", (err as Error).message);
		throw err;
	}

	const user = Array.isArray(newUser) ? newUser[0] : newUser;
	if (!user || typeof user !== "object" || !("id" in user)) {
		console.error("[register] insert returned no user. Check RLS policies and that SUPABASE_KEY is the service_role key.");
		return errorResponse("Registration failed — server error", 500);
	}

	const u = user as Record<string, unknown>;
	const secret = new TextEncoder().encode(env.JWT_SECRET);
	const token = await new SignJWT({ id: u.id, phone: u.phone, role: "user" })
		.setProtectedHeader({ alg: "HS256" })
		.setExpirationTime("365d")
		.sign(secret);

	const { password_hash: _ph, ...safeUser } = u;
	await sendTelegramMessage(env,
		`🆕 <b>New User Registered</b>\nPhone: <code>${u.phone}</code>${u.location ? `\nLocation: ${u.location}` : ""}\nID: <code>${u.id}</code>`
	);
	return successResponse({ user: safeUser, token }, "Registered successfully", 201);
}

async function handleUserLogin(request: Request, env: Env): Promise<Response> {
	const body = (await getBody(request)) as Record<string, unknown> | null;
	if (!body) return errorResponse("Invalid or empty JSON body", 400);
	const phone = typeof body.phone === "string" ? body.phone.trim() : "";
	if (!phone || typeof body.password !== "string") return errorResponse("Phone and password required", 400);

	const users = await callSupabase(env, `/rest/v1/users?phone=eq.${encodeURIComponent(phone)}&role=eq.user`) as Record<string, unknown>[] | null;
	if (!users || users.length === 0) return errorResponse("Invalid phone or password", 401);
	const user = users[0];
	if (user.is_active === false) return errorResponse("This account is disabled", 403);
	const valid = await verifyPassword(body.password as string, (user.password_hash as string) || "");
	if (!valid) return errorResponse("Invalid phone or password", 401);

	await callSupabase(env, `/rest/v1/users?id=eq.${user.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ last_login_at: new Date().toISOString() })
	});

	const secret = new TextEncoder().encode(env.JWT_SECRET);
	const token = await new SignJWT({ id: user.id, phone: user.phone, role: "user" })
		.setProtectedHeader({ alg: "HS256" })
		.setExpirationTime("365d")
		.sign(secret);

	const { password_hash: _ph, ...safeUser } = user;
	return successResponse({ user: safeUser, token }, "Login successful");
}

async function handleUserMe(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth) return errorResponse("Unauthorized", 401);
	try {
		const token = auth.replace("Bearer ", "");
		const secret = new TextEncoder().encode(env.JWT_SECRET);
		const { payload } = await jwtVerify(token, secret);
		if (payload.role !== "user") return errorResponse("Unauthorized", 401);
		const users = await callSupabase(env, `/rest/v1/users?id=eq.${payload.id}&role=eq.user`) as Record<string, unknown>[] | null;
		if (!users || users.length === 0) return errorResponse("User not found", 404);
		const { password_hash: _ph, ...safeUser } = users[0];
		return successResponse(safeUser, "User fetched successfully");
	} catch { return errorResponse("Unauthorized", 401); }
}

async function handleUserTickets(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth) return errorResponse("Unauthorized", 401);
	try {
		const token = auth.replace("Bearer ", "");
		const secret = new TextEncoder().encode(env.JWT_SECRET);
		const { payload } = await jwtVerify(token, secret);
		if (payload.role !== "user") return errorResponse("Unauthorized", 401);
		const tickets = await callSupabase(env,
			`/rest/v1/tickets?user_id=eq.${payload.id}&order=issued_at.desc&select=*`
		) as Record<string, unknown>[] | null;
		// fetch package names for each ticket
		const pkgIds = [...new Set((tickets || []).map(t => t.package_id as string))];
		let pkgMap: Record<string, string> = {};
		if (pkgIds.length > 0) {
			const pkgs = await callSupabase(env,
				`/rest/v1/packages?id=in.(${pkgIds.join(",")})&select=id,name`
			) as Record<string, unknown>[] | null;
			pkgMap = Object.fromEntries((pkgs || []).map(p => [p.id as string, p.name as string]));
		}
		const enriched = (tickets || []).map(t => ({ ...t, package_name: pkgMap[t.package_id as string] || "" }));
		return successResponse(enriched, "Tickets fetched successfully");
	} catch { return errorResponse("Unauthorized", 401); }
}

// ================= TELEGRAM STARS PAYMENT =================

function generateOrderId(seq: number): string {
	const d = new Date();
	const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
	return `ORD-${date}-${String(seq).padStart(4, "0")}`;
}

function generateTicketNumber(): string {
	return `TK-${String(Math.floor(100000 + Math.random() * 900000))}`;
}

function generateInvoicePayload(orderId: string): string {
	const rand = Math.random().toString(36).slice(2, 14);
	return `${orderId}_${rand}`;
}

async function bookingLog(env: Env, orderId: string | null, telegramId: number | null, event: string, success: boolean, detail: string) {
	try {
		await callSupabase(env, "/rest/v1/booking_logs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: orderId, telegram_id: telegramId, event, success, detail })
		});
	} catch { /* never break main flow */ }
}

// GET /api/packages — public
async function handleGetPackages(env: Env): Promise<Response> {
	const data = await callSupabase(env, "/rest/v1/packages?is_active=eq.true&order=sort_order.asc&select=*");
	return successResponse(data, "Packages fetched successfully");
}

// POST /api/orders — authenticated user creates a pending order
async function handleCreateOrder(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth) return errorResponse("Unauthorized", 401);
	let userId: string, userPhone: string;
	try {
		const { payload } = await jwtVerify(auth.replace("Bearer ", ""), new TextEncoder().encode(env.JWT_SECRET));
		if (payload.role !== "user") return errorResponse("Unauthorized", 401);
		userId = payload.id as string;
		userPhone = payload.phone as string;
	} catch { return errorResponse("Unauthorized", 401); }

	const body = (await getBody(request)) as Record<string, unknown> | null;
	if (!body?.package_id) return errorResponse("package_id required", 400);

	const pkgs = await callSupabase(env, `/rest/v1/packages?id=eq.${body.package_id}&is_active=eq.true&select=*`) as Record<string, unknown>[] | null;
	if (!pkgs || pkgs.length === 0) return errorResponse("Package not found or inactive", 404);
	const pkg = pkgs[0];
	if ((pkg.available_seats as number) <= 0) return errorResponse("No seats available for this package", 409);

	// generate sequential order id using today's count
	const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	const existing = await callSupabase(env, `/rest/v1/orders?order_id=like.ORD-${todayStr}*&select=id`) as unknown[] | null;
	const seq = (existing?.length ?? 0) + 1;
	const orderId = generateOrderId(seq);
	const invoicePayload = generateInvoicePayload(orderId);

	const newOrder = await callSupabase(env, "/rest/v1/orders", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
		body: JSON.stringify({
			order_id: orderId,
			user_id: userId,
			package_id: body.package_id,
			stars: pkg.stars,
			status: "pending",
			invoice_payload: invoicePayload
		})
	}) as Record<string, unknown>[] | null;

	const order = Array.isArray(newOrder) ? newOrder[0] : newOrder;
	await bookingLog(env, (order as Record<string, unknown>)?.id as string, null, "order_created", true,
		`package=${pkg.name} stars=${pkg.stars} user=${userPhone}`);

	const botUsername = (env.BOT_USERNAME || "").replace(/^@+/, "").trim();
	const deepLink = `https://t.me/${botUsername}?start=${orderId}`;
	return successResponse({ order, deep_link: deepLink }, "Order created", 201);
}

// POST /bot/webhook — Telegram bot webhook for Stars payments and CF tickets
async function handleBotWebhook(request: Request, env: Env): Promise<Response> {
	let update: Record<string, unknown>;
	try { update = await request.json() as Record<string, unknown>; }
	catch { return new Response("ok"); }

	const message = update.message as Record<string, unknown> | undefined;
	const callback = update.callback_query as Record<string, unknown> | undefined;
	const preCheckout = update.pre_checkout_query as Record<string, unknown> | undefined;

	// ── Route CF ticket callback buttons to the CF handler ──
	if (callback) {
		const data = callback.data as string | undefined;
		if (data?.startsWith("ticket:")) {
			return handleCfBotWebhook(new Request(request.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(update),
			}), env);
		}
	}

	// ── Route CF ticket text commands to the CF handler ──
	if (message) {
		const text = message.text as string | undefined;
		if (text === "/tickets" || text === "/mybookings") {
			return handleCfBotWebhook(new Request(request.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(update),
			}), env);
		}
	}

	// ── /start <ORDER_ID> ──
	if (message) {
		const chatId = (message.chat as Record<string, unknown>)?.id as number;
		const fromId = (message.from as Record<string, unknown>)?.id as number;
		const fromUsername = (message.from as Record<string, unknown>)?.username as string | undefined;
		const text = message.text as string | undefined;

		if (text?.startsWith("/start")) {
			const parts = text.split(" ");
			const orderId = parts[1]?.trim();

			// bare /start or a non-Stars payload belongs to the CF ticket flow
			if (!orderId || !orderId.startsWith("ORD-")) {
				return handleCfBotWebhook(new Request(request.url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(update),
				}), env);
			}

			const orders = await callSupabase(env, `/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`) as Record<string, unknown>[] | null;
			if (!orders || orders.length === 0) {
				await sendTgMessage(env, chatId, "❌ Order not found. Please go back to the website and try again.");
				return new Response("ok");
			}
			const order = orders[0];

			if (order.status === "paid") {
				await sendTgMessage(env, chatId, `✅ This order is already paid!\n🎫 Ticket: <b>${await getTicketForOrder(env, order.id as string)}</b>`);
				return new Response("ok");
			}
			if (order.status === "cancelled" || order.status === "failed") {
				await sendTgMessage(env, chatId, "❌ This order is no longer valid. Please create a new order on the website.");
				return new Response("ok");
			}

			// link telegram_id to order and user
			await callSupabase(env, `/rest/v1/orders?id=eq.${order.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ telegram_id: fromId })
			});
			await callSupabase(env, `/rest/v1/users?id=eq.${order.user_id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ telegram_id: fromId, telegram_username: fromUsername || null })
			});

			const pkgs = await callSupabase(env, `/rest/v1/packages?id=eq.${order.package_id}&select=*`) as Record<string, unknown>[] | null;
			const pkg = pkgs?.[0];
			if (!pkg) {
				await sendTgMessage(env, chatId, "❌ Package not found. Contact support.");
				return new Response("ok");
			}

			// send Stars invoice
			await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendInvoice`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: chatId,
					title: `${pkg.name} — DreamHome Realty`,
					description: pkg.description || `${pkg.stars} ⭐ property access package`,
					payload: order.invoice_payload,
					currency: "XTR",
					prices: [{ label: pkg.name, amount: pkg.stars }]
				})
			});
			await bookingLog(env, order.id as string, fromId, "invoice_sent", true, `package=${pkg.name}`);
		}

		// /mybookings
		if (text === "/mybookings") {
			const tickets = await callSupabase(env,
				`/rest/v1/tickets?user_id=in.(select id from users where telegram_id=eq.${fromId})&select=ticket_number,issued_at,stars,package_id&order=issued_at.desc&limit=5`
			) as Record<string, unknown>[] | null;
			if (!tickets || tickets.length === 0) {
				await sendTgMessage(env, chatId, "You have no bookings yet.");
			} else {
				const lines = tickets.map(t => `🎫 ${t.ticket_number} — ⭐${t.stars} — ${String(t.issued_at).slice(0, 10)}`).join("\n");
				await sendTgMessage(env, chatId, `<b>Your Bookings:</b>\n${lines}`);
			}
		}

		// /help
		if (text === "/help") {
			await sendTgMessage(env, chatId, "Browse packages on the website, click Buy, and pay with Telegram Stars here.");
		}
	}

	// ── pre_checkout_query ──
	if (preCheckout) {
		const queryId = preCheckout.id as string;
		const fromId = (preCheckout.from as Record<string, unknown>)?.id as number;
		const payload = preCheckout.invoice_payload as string;
		const currency = preCheckout.currency as string;
		const amount = preCheckout.total_amount as number;

		if (currency !== "XTR") {
			await answerPreCheckout(env, queryId, false, "Invalid currency");
			return new Response("ok");
		}
		const orders = await callSupabase(env, `/rest/v1/orders?invoice_payload=eq.${encodeURIComponent(payload)}&select=*`) as Record<string, unknown>[] | null;
		if (!orders || orders.length === 0) {
			await answerPreCheckout(env, queryId, false, "Order not found");
			return new Response("ok");
		}
		const order = orders[0];
		if (order.status !== "pending") {
			await answerPreCheckout(env, queryId, false, "Order already processed");
			return new Response("ok");
		}
		if (order.telegram_id !== fromId) {
			await answerPreCheckout(env, queryId, false, "Payer mismatch");
			return new Response("ok");
		}
		if (order.stars !== amount) {
			await answerPreCheckout(env, queryId, false, "Amount mismatch");
			await bookingLog(env, order.id as string, fromId, "pre_checkout_rejected", false, `expected=${order.stars} got=${amount}`);
			return new Response("ok");
		}
		await answerPreCheckout(env, queryId, true);
		await bookingLog(env, order.id as string, fromId, "pre_checkout_approved", true, "");
	}

	// ── successful_payment ──
	if (message?.successful_payment) {
		const sp = message.successful_payment as Record<string, unknown>;
		const fromId = (message.from as Record<string, unknown>)?.id as number;
		const chatId = (message.chat as Record<string, unknown>)?.id as number;
		const chargeId = sp.telegram_payment_charge_id as string;
		const providerChargeId = sp.provider_payment_charge_id as string;
		const payload = sp.invoice_payload as string;
		const stars = sp.total_amount as number;

		// idempotency check
		const existing = await callSupabase(env, `/rest/v1/payments?telegram_payment_charge_id=eq.${encodeURIComponent(chargeId)}&select=id`) as unknown[] | null;
		if (existing && existing.length > 0) return new Response("ok");

		const orders = await callSupabase(env, `/rest/v1/orders?invoice_payload=eq.${encodeURIComponent(payload)}&select=*`) as Record<string, unknown>[] | null;
		if (!orders || orders.length === 0) return new Response("ok");
		const order = orders[0];
		if (order.status !== "pending") return new Response("ok");

		// assign next available seat
		const seats = await callSupabase(env,
			`/rest/v1/seats?package_id=eq.${order.package_id}&status=eq.available&order=seat_number.asc&limit=1&select=*`
		) as Record<string, unknown>[] | null;
		if (!seats || seats.length === 0) {
			await bookingLog(env, order.id as string, fromId, "error", false, "No seats available at payment time");
			await sendTgMessage(env, chatId, "⚠️ Payment received but no seats available. Contact support immediately.");
			return new Response("ok");
		}
		const seat = seats[0];

		// book seat
		await callSupabase(env, `/rest/v1/seats?id=eq.${seat.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "booked", order_id: order.id, booked_at: new Date().toISOString() })
		});

		// decrement available_seats
		await callSupabase(env, `/rest/v1/packages?id=eq.${order.package_id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ available_seats: (await getPackageAvailableSeats(env, order.package_id as string)) - 1 })
		});

		// record payment
		await callSupabase(env, "/rest/v1/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				order_id: order.id,
				telegram_id: fromId,
				invoice_payload: payload,
				telegram_payment_charge_id: chargeId,
				provider_payment_charge_id: providerChargeId,
				stars,
				currency: "XTR",
				paid_at: new Date().toISOString()
			})
		});

		// generate unique ticket number
		let ticketNumber = generateTicketNumber();
		const tCheck = await callSupabase(env, `/rest/v1/tickets?ticket_number=eq.${ticketNumber}&select=id`) as unknown[] | null;
		if (tCheck && tCheck.length > 0) ticketNumber = generateTicketNumber() + Math.floor(Math.random() * 9);

		// insert ticket
		const ticketRows = await callSupabase(env, "/rest/v1/tickets", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
			body: JSON.stringify({
				ticket_number: ticketNumber,
				order_id: order.id,
				user_id: order.user_id,
				package_id: order.package_id,
				stars,
				issued_at: new Date().toISOString()
			})
		}) as Record<string, unknown>[] | null;
		const ticket = Array.isArray(ticketRows) ? ticketRows[0] : ticketRows;

		// mark order paid
		await callSupabase(env, `/rest/v1/orders?id=eq.${order.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				status: "paid",
				ticket_id: (ticket as Record<string, unknown>)?.id,
				seat_number: seat.seat_number,
				confirmed_at: new Date().toISOString()
			})
		});

		await bookingLog(env, order.id as string, fromId, "payment_received", true,
			`charge=${chargeId} seat=${seat.seat_number} ticket=${ticketNumber}`);

		// get package name for confirmation
		const pkgs = await callSupabase(env, `/rest/v1/packages?id=eq.${order.package_id}&select=name`) as Record<string, unknown>[] | null;
		const pkgName = pkgs?.[0]?.name || "Package";

		const confirmMsg = `✅ <b>Payment Confirmed!</b>\n\n🎫 Ticket: <b>${ticketNumber}</b>\n📦 Package: ${pkgName}\n💺 Seat: ${seat.seat_number}\n⭐ Stars Paid: ${stars}\n📅 Date: ${new Date().toDateString()}\n\n👉 View your ticket on the website`;
		await sendTgMessage(env, chatId, confirmMsg);
		await bookingLog(env, order.id as string, fromId, "confirmation_sent", true, ticketNumber);

		// notify admin
		await sendTelegramMessage(env, `💰 <b>Payment Received</b>\nTicket: <code>${ticketNumber}</code>\nPackage: ${pkgName}\nSeat: ${seat.seat_number}\n⭐ ${stars} Stars`);
	}

	return new Response("ok");
}

async function sendTgMessage(env: Env, chatId: number, text: string) {
	if (!env.TELEGRAM_BOT_TOKEN) return;
	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
	});
}

async function answerPreCheckout(env: Env, queryId: string, ok: boolean, errorMessage?: string) {
	if (!env.TELEGRAM_BOT_TOKEN) return;
	await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pre_checkout_query_id: queryId, ok, ...(errorMessage ? { error_message: errorMessage } : {}) })
	});
}

async function getTicketForOrder(env: Env, orderId: string): Promise<string> {
	const t = await callSupabase(env, `/rest/v1/tickets?order_id=eq.${orderId}&select=ticket_number`) as Record<string, unknown>[] | null;
	return (t?.[0]?.ticket_number as string) || "N/A";
}

async function getPackageAvailableSeats(env: Env, packageId: string): Promise<number> {
	const p = await callSupabase(env, `/rest/v1/packages?id=eq.${packageId}&select=available_seats`) as Record<string, unknown>[] | null;
	return (p?.[0]?.available_seats as number) ?? 0;
}

// ================= CASHFREE TICKET BOT =================

import {
	createCashfreeOrder,
	verifyCashfreeWebhook,
	getCashfreePaymentStatus,
} from "./cashfree";

const TICKET_TYPES: Record<string, number> = {
	free: 0,
	normal: 100,  // ₹1 in paise
	vip: 200,     // ₹2 in paise
	premium: 300, // ₹3 in paise
};

const TICKET_LABELS: Record<string, string> = {
	free: "Free     ₹0",
	normal: "Normal  ₹1",
	vip: "VIP     ₹2",
	premium: "Premium ₹3",
};

function formatINR(paise: number): string {
	return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

// Cashfree accepts a numeric customer phone. Keep the original phone on the
// ticket, while sending a 10-digit Indian mobile number to checkout when one
// is available. The fallback keeps old Telegram-only bookings working.
function cashfreeCustomerPhone(phone: string | null): string {
	const digits = (phone || "").replace(/\D/g, "");
	if (digits.length === 10) return digits;
	if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
	return "9999999999";
}

function generateSgOrderId(seq: number): string {
	const d = new Date();
	const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
	return `SG-${date}-${String(seq).padStart(6, "0")}`;
}

function generateCfTicketNumber(): string {
	return `SG-${new Date().getFullYear()}-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

async function cfLog(env: Env, event: string, orderId: string | null, detail: string) {
	try {
		await callSupabase(env, "/rest/v1/booking_logs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: orderId, event, success: true, detail }),
		});
	} catch { /* never break main flow */ }
}

async function sendCfBotMessage(
	env: Env,
	chatId: number,
	text: string,
	replyMarkup?: Record<string, unknown>
) {
	// CF bot always uses its own dedicated token — no fallback to the Stars bot token,
	// since they are now two genuinely separate bots and cross-sending would silently fail.
	const botKey = await getActiveIntegrationKey(env, "active_telegram_key", "cashfree_bot");
	const token = await getIntegrationSecret(env, "telegram_bots", botKey, "CF_BOT_TOKEN", env.CF_BOT_TOKEN);
	if (!token) {
		console.error("[CF] CF_BOT_TOKEN not configured — cannot send message");
		return;
	}
	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: "HTML",
			...(replyMarkup ? { reply_markup: replyMarkup } : {}),
		}),
	});
}

// Free tickets never go to Cashfree. We still create an order and a completed
// internal attempt so the ticket has the same complete audit trail as a paid one.
async function issueFreeTicket(env: Env, ticketOrder: Record<string, unknown>): Promise<Record<string, unknown> | null> {
	const attempts = await callSupabase(env, "/rest/v1/payment_attempts", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
		body: JSON.stringify({
			ticket_order_id: ticketOrder.id,
			attempt_number: 1,
			provider: "free",
			amount_paise: 0,
			status: "success",
		}),
	}) as Record<string, unknown>[] | null;
	const attempt = attempts?.[0];
	if (!attempt) return null;

	const ticketNumber = generateCfTicketNumber();
	const rows = await callSupabase(env, "/rest/v1/issued_tickets", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
		body: JSON.stringify({
			ticket_number: ticketNumber,
			ticket_order_id: ticketOrder.id,
			payment_attempt_id: attempt.id,
			telegram_user_id: ticketOrder.telegram_user_id,
			telegram_chat_id: ticketOrder.telegram_chat_id,
			website_user_id: ticketOrder.website_user_id || null,
			customer_phone: ticketOrder.customer_phone || null,
			ticket_type: "free",
			amount_paise: 0,
			provider: "free",
			status: "active",
		}),
	}) as Record<string, unknown>[] | null;
	const ticket = rows?.[0];
	if (!ticket) return null;

	await callSupabase(env, `/rest/v1/ticket_orders?id=eq.${ticketOrder.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "paid" }),
	});
	return ticket;
}

// Recovery path for the Cashfree return button. Cashfree's own API remains the
// source of truth; this only helps when its webhook is delayed or retried.
async function issueVerifiedCashfreeTicket(
	env: Env,
	ticketOrder: Record<string, unknown>,
	attempt: Record<string, unknown>,
	cfPaymentId: string
): Promise<Record<string, unknown> | null> {
	const existing = await callSupabase(env,
		`/rest/v1/issued_tickets?ticket_order_id=eq.${ticketOrder.id}&select=*`
	) as Record<string, unknown>[] | null;
	if (existing?.[0]) return existing[0];

	await callSupabase(env, `/rest/v1/payment_attempts?id=eq.${attempt.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "success", cf_payment_id: cfPaymentId }),
	});

	const ticketNumber = generateCfTicketNumber();
	const rows = await callSupabase(env, "/rest/v1/issued_tickets", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
		body: JSON.stringify({
			ticket_number: ticketNumber,
			ticket_order_id: ticketOrder.id,
			payment_attempt_id: attempt.id,
			telegram_user_id: ticketOrder.telegram_user_id,
			telegram_chat_id: ticketOrder.telegram_chat_id,
			website_user_id: ticketOrder.website_user_id || null,
			customer_phone: ticketOrder.customer_phone || null,
			ticket_type: ticketOrder.ticket_type,
			amount_paise: ticketOrder.amount_paise,
			provider: "cashfree",
			cf_payment_id: cfPaymentId,
			status: "active",
		}),
	}) as Record<string, unknown>[] | null;
	const ticket = rows?.[0];
	if (!ticket) return null;

	await callSupabase(env, `/rest/v1/ticket_orders?id=eq.${ticketOrder.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "paid" }),
	});
	return ticket;
}

// POST /cf-bot/webhook — Telegram webhook for the Cashfree ticket bot
async function handleCfBotWebhook(request: Request, env: Env): Promise<Response> {
	let update: Record<string, unknown>;
	try { update = await request.json() as Record<string, unknown>; }
	catch { return new Response("ok"); }

	const message = update.message as Record<string, unknown> | undefined;
	const callback = update.callback_query as Record<string, unknown> | undefined;
	if (!(await isCashfreeFlowActive(env))) {
		const chatId = (message?.chat as Record<string, unknown>)?.id as number
			|| ((callback?.message as Record<string, unknown>)?.chat as Record<string, unknown>)?.id as number;
		if (chatId) await sendCfBotMessage(env, chatId, "Ticket booking is temporarily unavailable. Please try again later.");
		return new Response("ok");
	}

	if (message) {
		const chatId = (message.chat as Record<string, unknown>)?.id as number;
		const fromId = (message.from as Record<string, unknown>)?.id as number;
		const username = (message.from as Record<string, unknown>)?.username as string | undefined;
		const text = message.text as string | undefined;

		if (text?.startsWith("/start") || text === "/tickets") {
			// extract website user_id if passed as start param: /start <user_id>
			const startParam = text.startsWith("/start ") ? text.split(" ")[1]?.trim() : null;
			// cf_return is just a signal to show the menu / latest order, not a user ID
			const websiteUserId = startParam && startParam !== "cf_return" && startParam.length > 10 ? startParam : null;

			// store telegram_id linked to website user if provided
			if (websiteUserId) {
				try {
					await callSupabase(env, `/rest/v1/users?id=eq.${websiteUserId}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ telegram_id: fromId, telegram_username: username || null }),
					});
				} catch { /* non-critical */ }
			}

			// ── If returning from Cashfree payment, check their latest order first ──
			if (startParam === "cf_return" || text === "/tickets") {
				const recentOrders = await callSupabase(env,
					`/rest/v1/ticket_orders?telegram_user_id=eq.${fromId}&order=created_at.desc&limit=1&select=*`
				) as Record<string, unknown>[] | null;
				const latestOrder = recentOrders?.[0];

				if (latestOrder?.status === "paid") {
					const issuedRows = await callSupabase(env,
						`/rest/v1/issued_tickets?ticket_order_id=eq.${latestOrder.id}&select=*`
					) as Record<string, unknown>[] | null;
					const ticket = issuedRows?.[0];
					if (ticket) {
						await sendCfBotMessage(env, chatId,
							`🎉 <b>PAYMENT SUCCESSFUL</b>\n\n🎟 <b>Your Ticket</b>\n\nTicket: <code>${ticket.ticket_number}</code>\nType: ${String(ticket.ticket_type).toUpperCase()}\nAmount: ${formatINR(ticket.amount_paise as number)}\n\nThank you for your purchase!`
						);
						return new Response("ok");
					}
				}
				if (latestOrder?.status === "awaiting_payment") {
					// The return button can arrive before Cashfree's webhook. Verify
					// directly with Cashfree and issue the same website ticket here.
					try {
						const attempts = await callSupabase(env,
							`/rest/v1/payment_attempts?ticket_order_id=eq.${latestOrder.id}&order=created_at.desc&limit=1&select=*`
						) as Record<string, unknown>[] | null;
						const attempt = attempts?.[0];
						const cashfree = await getCashfreeCredentials(env);
						if (attempt && latestOrder.internal_order_id && cashfree.CASHFREE_CLIENT_ID && cashfree.CASHFREE_CLIENT_SECRET) {
							const liveStatus = await getCashfreePaymentStatus(
								cashfree as { CASHFREE_CLIENT_ID: string; CASHFREE_CLIENT_SECRET: string; CASHFREE_ENVIRONMENT: string },
								latestOrder.internal_order_id as string
							);
							const expectedRupees = Number(latestOrder.amount_paise) / 100;
							if (liveStatus?.status === "SUCCESS" && Math.abs(liveStatus.amount - expectedRupees) <= 0.01) {
								const ticket = await issueVerifiedCashfreeTicket(env, latestOrder, attempt, liveStatus.cf_payment_id);
								if (ticket) {
									await sendCfBotMessage(env, chatId,
										`🎉 <b>PAYMENT SUCCESSFUL</b>\n\n🎟 <b>Your Ticket</b>\n\nTicket: <code>${ticket.ticket_number}</code>\nType: ${String(ticket.ticket_type).toUpperCase()}\nAmount: ${formatINR(ticket.amount_paise as number)}\n\nYour ticket is also available on the website.`
									);
									return new Response("ok");
								}
							}
						}
					} catch (err) {
						console.error("[CF return] payment verification failed", (err as Error).message);
					}
					await sendCfBotMessage(env, chatId,
						"⏳ Your payment is still being verified. This usually takes a few seconds — send /tickets in a moment to check again."
					);
					return new Response("ok");
				}
				// no order found or other status — fall through to ticket menu
			}

			await sendCfBotMessage(env, chatId,
				"🎟 <b>Select Your Ticket</b>\n\nChoose a ticket type to proceed with payment:",
				{
					inline_keyboard: [
						[{ text: "🎟 Free     ₹0", callback_data: "ticket:free" }],
						[{ text: "🎫 Normal  ₹1", callback_data: "ticket:normal" }],
						[{ text: "⭐ VIP     ₹2", callback_data: "ticket:vip" }],
						[{ text: "💎 Premium ₹3", callback_data: "ticket:premium" }],
					],
				}
			);
			return new Response("ok");
		}

		if (text === "/mybookings") {
			const rows = await callSupabase(env,
				`/rest/v1/issued_tickets?telegram_user_id=eq.${fromId}&order=issued_at.desc&limit=5&select=ticket_number,ticket_type,amount_paise,issued_at`
			) as Record<string, unknown>[] | null;
			if (!rows || rows.length === 0) {
				await sendCfBotMessage(env, chatId, "You have no tickets yet.");
			} else {
				const lines = rows.map(t =>
					`🎫 <b>${t.ticket_number}</b> — ${String(t.ticket_type).toUpperCase()} — ${formatINR(t.amount_paise as number)} — ${String(t.issued_at).slice(0, 10)}`
				).join("\n");
				await sendCfBotMessage(env, chatId, `<b>Your Tickets:</b>\n\n${lines}`);
			}
			return new Response("ok");
		}
	}

	if (callback) {
		const callbackId = callback.id as string;
		const chatId = (callback.message as Record<string, unknown>)?.chat as Record<string, unknown>;
		const chatIdNum = chatId?.id as number;
		const fromId = (callback.from as Record<string, unknown>)?.id as number;
		const username = (callback.from as Record<string, unknown>)?.username as string | undefined;
		const data = callback.data as string | undefined;

		// answer callback immediately (always via the CF bot's own token)
		const callbackBotKey = await getActiveIntegrationKey(env, "active_telegram_key", "cashfree_bot");
		const callbackToken = await getIntegrationSecret(env, "telegram_bots", callbackBotKey, "CF_BOT_TOKEN", env.CF_BOT_TOKEN);
		if (callbackToken) {
			await fetch(`https://api.telegram.org/bot${callbackToken}/answerCallbackQuery`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ callback_query_id: callbackId }),
			});
		}

		if (data?.startsWith("ticket:")) {
			const ticketType = data.split(":")[1];
			const amountPaise = TICKET_TYPES[ticketType];
			if (amountPaise === undefined) return new Response("ok");

			const cashfree = await getCashfreeCredentials(env);
			if (amountPaise > 0 && (!cashfree.CASHFREE_CLIENT_ID || !cashfree.CASHFREE_CLIENT_SECRET)) {
				await sendCfBotMessage(env, chatIdNum, "Sorry, we could not create your payment right now. Please try again.");
				return new Response("ok");
			}

			// generate sequential internal order ID
			const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
			const existing = await callSupabase(env,
				`/rest/v1/ticket_orders?internal_order_id=like.SG-${todayStr}*&select=id`
			) as unknown[] | null;
			const seq = (existing?.length ?? 0) + 1;
			const internalOrderId = generateSgOrderId(seq);

			// create internal order
			// look up website_user_id via telegram_id linkage
			let websiteUserId: string | null = null;
			let customerPhone: string | null = null;
			try {
				const linkedUsers = await callSupabase(env,
					`/rest/v1/users?telegram_id=eq.${fromId}&select=id,phone`
				) as Record<string, unknown>[] | null;
				websiteUserId = linkedUsers?.[0]?.id as string || null;
				customerPhone = linkedUsers?.[0]?.phone as string || null;
			} catch { /* non-critical */ }

			const orderRows = await callSupabase(env, "/rest/v1/ticket_orders", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
				body: JSON.stringify({
					internal_order_id: internalOrderId,
					telegram_user_id: fromId,
					telegram_chat_id: chatIdNum,
					telegram_username: username || null,
					website_user_id: websiteUserId,
					customer_phone: customerPhone,
					ticket_type: ticketType,
					amount_paise: amountPaise,
					status: "awaiting_payment",
				}),
			}) as Record<string, unknown>[] | null;

			const order = Array.isArray(orderRows) ? orderRows[0] : orderRows;
			if (!order) {
				await sendCfBotMessage(env, chatIdNum, "Sorry, we could not create your payment right now. Please try again.");
				return new Response("ok");
			}

			cfLog(env, "ORDER_CREATED", order.id as string,
				`type=${ticketType} amount=${amountPaise} tg=${fromId}`);

			if (amountPaise === 0) {
				try {
					const ticket = await issueFreeTicket(env, order);
					if (!ticket) throw new Error("Ticket creation did not return a ticket");
					await sendCfBotMessage(env, chatIdNum,
						`🎉 <b>FREE TICKET CONFIRMED</b>\n\n🎟 <b>Your Ticket</b>\n\nTicket: <code>${ticket.ticket_number}</code>\nType: FREE\nAmount: ₹0\n\nYour ticket is also available on the website.`
					);
					cfLog(env, "FREE_TICKET_CREATED", order.id as string, `ticket=${ticket.ticket_number}`);
				} catch (err) {
					console.error("[CF] free ticket creation failed", (err as Error).message);
					await sendCfBotMessage(env, chatIdNum, "Sorry, we could not create your free ticket right now. Please try again.");
				}
				return new Response("ok");
			}

			// create Cashfree order
			let cfResult;
			try {
				cfResult = await createCashfreeOrder(
					{ CASHFREE_CLIENT_ID: cashfree.CASHFREE_CLIENT_ID!, CASHFREE_CLIENT_SECRET: cashfree.CASHFREE_CLIENT_SECRET!, CASHFREE_ENVIRONMENT: cashfree.CASHFREE_ENVIRONMENT },
					{
						orderId: internalOrderId,
						amountPaise,
						customerName: username || `User${fromId}`,
						customerId: `tg_${fromId}`,
						customerPhone: cashfreeCustomerPhone(customerPhone),
						returnUrl: `${env.API_BASE_URL || ""}/cf-payment/return?order_id=${internalOrderId}`,
					}
				);
			} catch (err) {
				console.error("[CF] order creation failed", (err as Error).message);
				await sendCfBotMessage(env, chatIdNum, "Sorry, we could not create your payment right now. Please try again.");
				return new Response("ok");
			}

			// store payment attempt
			await callSupabase(env, "/rest/v1/payment_attempts", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
				body: JSON.stringify({
					ticket_order_id: order.id,
					attempt_number: 1,
					provider: "cashfree",
					cf_order_id: cfResult.cf_order_id,
					cf_payment_session: cfResult.payment_session_id,
					payment_link: cfResult.payment_link,
					amount_paise: amountPaise,
					status: "created",
				}),
			});

			cfLog(env, "PAYMENT_CREATED", order.id as string,
				`cf_order=${cfResult.cf_order_id}`);

			const paymentPageUrl = `${env.API_BASE_URL || ""}/cf-payment/checkout?session_id=${cfResult.payment_session_id}`;
			const label = TICKET_LABELS[ticketType] || ticketType;
			await sendCfBotMessage(env, chatIdNum,
				`🎟 <b>${label.trim()} Ticket</b>\n\nAmount: <b>${formatINR(amountPaise)}</b>\nOrder: <code>${internalOrderId}</code>\n\nTap the button below to complete your payment:`,
				{
					inline_keyboard: [[
						{ text: `💳 Pay ${formatINR(amountPaise)}`, url: paymentPageUrl },
					]],
				}
			);
		}
	}

	return new Response("ok");
}

// POST /cashfree/webhook — Cashfree payment webhook
async function handleCashfreeWebhook(request: Request, env: Env): Promise<Response> {
	const rawBody = await request.text();
	const timestamp = request.headers.get("x-webhook-timestamp") || "";
	const signature = request.headers.get("x-webhook-signature") || "";

	// 1. Verify signature
	const cashfree = await getCashfreeCredentials(env);
	const secret = cashfree.CASHFREE_WEBHOOK_SECRET || "";
	const valid = secret
		? await verifyCashfreeWebhook(secret, rawBody, timestamp, signature)
		: false;

	let payload: Record<string, unknown>;
	try { payload = JSON.parse(rawBody) as Record<string, unknown>; }
	catch { return new Response("ok"); }

	const eventType = payload.type as string | undefined;
	const data = payload.data as Record<string, unknown> | undefined;
	const orderData = data?.order as Record<string, unknown> | undefined;
	const payData = data?.payment as Record<string, unknown> | undefined;

	const cfOrderId = (orderData?.order_id as string) || "";
	const cfPaymentId = String(payData?.cf_payment_id || "");

	// 2. Log raw webhook event
	try {
		await callSupabase(env, "/rest/v1/cf_webhook_events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				cf_order_id: cfOrderId,
				cf_payment_id: cfPaymentId,
				event_type: eventType,
				payload: payload,
				signature_valid: valid,
				processed: false,
			}),
		});
	} catch { /* log failure must not break flow */ }

	if (!valid && secret) {
		console.warn("[CF webhook] invalid signature, ignoring");
		return new Response("ok");
	}

	if (eventType !== "PAYMENT_SUCCESS_WEBHOOK") {
		return new Response("ok");
	}

	// 3. Find internal order by internal_order_id (cf_order_id == your order_id passed at creation)
	const orderLookup = await callSupabase(env,
		`/rest/v1/ticket_orders?internal_order_id=eq.${encodeURIComponent(cfOrderId)}&select=*`
	) as Record<string, unknown>[] | null;

	if (!orderLookup || orderLookup.length === 0) {
		console.warn("[CF webhook] no ticket_order found for", cfOrderId);
		return new Response("ok");
	}
	const ticketOrder = orderLookup[0];

	// 4. Idempotency — check if a ticket already exists for this order
	//    NOTE: PostgREST does not support raw SQL subqueries in filters (the previous
	//    `ticket_order_id=in.(select ...)` syntax always returns a 400). Do it as two
	//    plain lookups instead.
	const existingTicket = await callSupabase(env,
		`/rest/v1/issued_tickets?ticket_order_id=eq.${ticketOrder.id}&select=id`
	) as unknown[] | null;
	if (existingTicket && existingTicket.length > 0) {
		console.info("[CF webhook] already processed", cfOrderId);
		return new Response("ok");
	}

	// 5. Find the matching payment attempt by our merchant order row. Cashfree's
	// webhook order_id is the merchant order ID, while cf_order_id is a separate
	// provider-generated identifier returned when the order is created.
	const attempts = await callSupabase(env,
		`/rest/v1/payment_attempts?ticket_order_id=eq.${ticketOrder.id}&order=created_at.desc&limit=1&select=*`
	) as Record<string, unknown>[] | null;
	if (!attempts || attempts.length === 0) {
		console.warn("[CF webhook] no attempt found for", cfOrderId);
		return new Response("ok");
	}
	const attempt = attempts[0];

	// 6. Verify amount
	const paidAmount = Number(orderData?.order_amount || 0);
	const expectedRupees = (ticketOrder.amount_paise as number) / 100;
	if (Math.abs(paidAmount - expectedRupees) > 0.01) {
		console.error("[CF webhook] amount mismatch", paidAmount, expectedRupees);
		return new Response("ok");
	}

	// 7. Verify payment status from Cashfree directly
	const liveStatus = await getCashfreePaymentStatus(
		{ CASHFREE_CLIENT_ID: cashfree.CASHFREE_CLIENT_ID!, CASHFREE_CLIENT_SECRET: cashfree.CASHFREE_CLIENT_SECRET!, CASHFREE_ENVIRONMENT: cashfree.CASHFREE_ENVIRONMENT },
		cfOrderId
	);
	if (!liveStatus || liveStatus.status !== "SUCCESS") {
		console.warn("[CF webhook] live status not SUCCESS", liveStatus?.status);
		return new Response("ok");
	}

	// 8. Mark attempt success
	await callSupabase(env, `/rest/v1/payment_attempts?id=eq.${attempt.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "success", cf_payment_id: cfPaymentId }),
	});

	// 9. Mark order paid
	await callSupabase(env, `/rest/v1/ticket_orders?id=eq.${ticketOrder.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status: "paid" }),
	});

	// 10. Generate unique ticket number (timestamp + random suffix; enforced unique at DB level too)
	const ticketNumber = generateCfTicketNumber();

	// 11. Issue ticket (idempotent via UNIQUE on ticket_order_id at the DB level as a second guard)
	let issuedTicket: Record<string, unknown> | null = null;
	try {
		const rows = await callSupabase(env, "/rest/v1/issued_tickets", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
			body: JSON.stringify({
				ticket_number: ticketNumber,
				ticket_order_id: ticketOrder.id,
				payment_attempt_id: attempt.id,
				telegram_user_id: ticketOrder.telegram_user_id,
				telegram_chat_id: ticketOrder.telegram_chat_id,
				website_user_id: ticketOrder.website_user_id || null,
				customer_phone: ticketOrder.customer_phone || null,
				ticket_type: ticketOrder.ticket_type,
				amount_paise: ticketOrder.amount_paise,
				provider: "cashfree",
				cf_payment_id: cfPaymentId,
				status: "active",
			}),
		}) as Record<string, unknown>[] | null;
		issuedTicket = Array.isArray(rows) ? rows[0] : rows;
	} catch (err) {
		console.error("[CF webhook] ticket insert failed", (err as Error).message);
		// still try to notify the user even if DB insert failed
		const chatIdFallback = ticketOrder.telegram_chat_id as number;
		await sendCfBotMessage(env, chatIdFallback,
			`✅ Payment received! Your ticket is being processed. If you don't receive it within 5 minutes, contact support with order: <code>${ticketOrder.internal_order_id as string}</code>`
		);
		return new Response("ok");
	}

	cfLog(env, "TICKET_CREATED", ticketOrder.id as string,
		`ticket=${ticketNumber} cf_payment=${cfPaymentId}`);

	// 12. Send ticket to Telegram
	const chatId = ticketOrder.telegram_chat_id as number;
	const typeLabel = String(ticketOrder.ticket_type).toUpperCase();
	const amount = formatINR(ticketOrder.amount_paise as number);

	await sendCfBotMessage(env, chatId,
		`🎉 <b>PAYMENT SUCCESSFUL</b>\n\n🎟 <b>Your Ticket</b>\n\nTicket: <code>${ticketNumber}</code>\nType: ${typeLabel}\nAmount: ${amount}\n\nThank you for your purchase!`
	);

	cfLog(env, "TICKET_SENT", ticketOrder.id as string, `chat=${chatId}`);

	// mark webhook processed
	try {
		await callSupabase(env,
			`/rest/v1/cf_webhook_events?cf_order_id=eq.${encodeURIComponent(cfOrderId)}&processed=eq.false`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processed: true }) }
		);
	} catch { /* non-critical */ }

	return new Response("ok");
}

// GET /cf-payment/checkout — auto-submits to Cashfree hosted checkout using payment_session_id
async function handleCfPaymentCheckout(url: URL, env: Env): Promise<Response> {
	const sessionId = url.searchParams.get("session_id") || "";
	if (!sessionId) return new Response("Missing session_id", { status: 400 });

	const checkoutUrl = env.CASHFREE_ENVIRONMENT === "production"
		? "https://api.cashfree.com/pg/view/sessions/checkout"
		: "https://sandbox.cashfree.com/pg/view/sessions/checkout";

	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting to payment...</title></head>
<body>
<p>Redirecting to secure payment page...</p>
<form id="cfForm" method="post" action="${checkoutUrl}">
  <input type="hidden" name="payment_session_id" value="${sessionId}" />
</form>
<script>document.getElementById('cfForm').submit();</script>
</body></html>`;

	return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// GET /cf-payment/return — browser return URL after Cashfree checkout
async function handleCfPaymentReturn(url: URL, env: Env): Promise<Response> {
	const orderId = url.searchParams.get("order_id") || "";
	const botUsername = (env.CF_BOT_USERNAME || "").replace(/^@+/, "").trim();
	const telegramDeepLink = botUsername
		? `https://t.me/${botUsername}?start=cf_return`
		: "https://t.me";
	const websiteUrl = env.WEBSITE_URL || "/";

	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Received</title>
<meta http-equiv="refresh" content="2;url=${telegramDeepLink}">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8f9fa}
.box{text-align:center;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:90%}
h2{color:#22c55e}p{color:#555}
a.btn{display:inline-block;margin-top:1rem;padding:.75rem 1.5rem;background:#229ED9;color:#fff;border-radius:.5rem;text-decoration:none;font-weight:600}
a.btn2{display:inline-block;margin-top:.75rem;padding:.75rem 1.5rem;background:#22c55e;color:#fff;border-radius:.5rem;text-decoration:none;font-weight:600}
</style></head>
<body><div class="box"><h2>✅ Payment Received</h2>
<p>Your payment for order <b>${orderId}</b> is being verified.</p>
<p>Your ticket will be sent on Telegram and will also appear on the website.</p>
<a class="btn" href="${telegramDeepLink}">Open Telegram Now</a><br/>
<a class="btn2" href="${websiteUrl}">View Ticket on Website</a>
<p style="margin-top:1.5rem;font-size:.85rem;color:#999">If you're not redirected automatically, tap a button above.</p>
</div></body></html>`;
	return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// GET /api/user-auth/cf-tickets — user: fetch their own Cashfree tickets
async function handleUserCfTickets(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth) return errorResponse("Unauthorized", 401);
	try {
		const { payload } = await jwtVerify(auth.replace("Bearer ", ""), new TextEncoder().encode(env.JWT_SECRET));
		if (payload.role !== "user") return errorResponse("Unauthorized", 401);
		const userId = payload.id as string;
		const userPhone = typeof payload.phone === "string" ? payload.phone : null;

		// Some older Cashfree tickets were stored before website_user_id existed.
		// Always merge both lookups: a Free ticket with a website link must not
		// hide paid tickets that are linked through the same Telegram account.
		const websiteTickets = await callSupabase(env,
			`/rest/v1/issued_tickets?website_user_id=eq.${userId}&order=issued_at.desc&select=*`
		) as Record<string, unknown>[] | null;

		const users = await callSupabase(env,
			`/rest/v1/users?id=eq.${userId}&select=telegram_id`
		) as Record<string, unknown>[] | null;
		const telegramUserId = users?.[0]?.telegram_id;
		const telegramTickets = telegramUserId
			? await callSupabase(env,
				`/rest/v1/issued_tickets?telegram_user_id=eq.${telegramUserId}&order=issued_at.desc&select=*`
			) as Record<string, unknown>[] | null
			: [];

		const uniqueTickets = new Map<string, Record<string, unknown>>();
		for (const ticket of [...(websiteTickets || []), ...(telegramTickets || [])]) {
			uniqueTickets.set(String(ticket.id), ticket);
		}
		const tickets = [...uniqueTickets.values()].sort((a, b) =>
			String(b.issued_at || "").localeCompare(String(a.issued_at || ""))
		);

		// Older tickets did not have a phone snapshot. Show the authenticated
		// customer's phone for those records without exposing it to other users.
		const ticketCards = tickets.map(ticket => ({
			...ticket,
			customer_phone: ticket.customer_phone || userPhone,
		}));
		return successResponse(ticketCards, "CF tickets fetched");
	} catch { return errorResponse("Unauthorized", 401); }
}

// GET /api/cf-tickets — admin: list all issued tickets
async function handleAdminCfTickets(request: Request, env: Env): Promise<Response> {
	if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
	const data = await callSupabase(env,
		"/rest/v1/issued_tickets?order=issued_at.desc&select=*"
	);
	return successResponse(data, "CF tickets fetched");
}

// GET /api/cf-orders — admin: list all ticket orders
async function handleAdminCfOrders(request: Request, env: Env): Promise<Response> {
	if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
	const data = await callSupabase(env,
		"/rest/v1/ticket_orders?order=created_at.desc&select=*"
	);
	return successResponse(data, "CF orders fetched");
}

// Runtime integration settings. Secrets remain in Cloudflare bindings; these
// tables only control which already-configured adapters are active.
async function handleIntegrationSettings(request: Request, env: Env): Promise<Response> {
	if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
	try {
		const [gatewayRows, botRows, flowRows] = await Promise.all([
			callSupabase(env, "/rest/v1/payment_gateways?order=key.asc&select=key,provider_key,account_label,display_name,enabled,adapter_status,environment,required_secrets,encrypted_secrets"),
			callSupabase(env, "/rest/v1/telegram_bots?order=key.asc&select=key,bot_id,display_name,username,webhook_path,purpose,enabled,required_secrets,encrypted_secrets"),
			callSupabase(env, "/rest/v1/flow_settings?id=eq.1&select=*")
		]);
		const gateways = (gatewayRows as Record<string, unknown>[]).map(({ encrypted_secrets: _encrypted, ...gateway }) => gateway);
		const bots = (botRows as Record<string, unknown>[]).map(({ encrypted_secrets: _encrypted, ...bot }) => bot);
		const gatewaySecretRows = gatewayRows as Record<string, unknown>[];
		const botSecretRows = botRows as Record<string, unknown>[];
		const configured = Object.fromEntries(gatewaySecretRows.map(row => [
			String(row.key),
			Object.keys((row.encrypted_secrets || {}) as object).length > 0
			|| (row.key === "cashfree" && Boolean(env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET && env.CASHFREE_WEBHOOK_SECRET))
		]));
		for (const row of botSecretRows) configured[String(row.key)] = Object.keys((row.encrypted_secrets || {}) as object).length > 0 || (row.key === "cashfree_bot" && Boolean(env.CF_BOT_TOKEN));
		return successResponse({
			gateways,
			bots,
			flow: (flowRows as Record<string, unknown>[])?.[0] || null,
			configured
		}, "Integration settings fetched");
	} catch (err) {
		return errorResponse(`Integration settings are not initialized: ${(err as Error).message}`, 503);
	}
}

async function updateIntegrationSettings(request: Request, env: Env): Promise<Response> {
	if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
	const body = await getBody(request) as Record<string, unknown> | null;
	if (!body) return errorResponse("Invalid JSON body");

	try {
		if (body.gateway_key) {
			const key = String(body.gateway_key);
			const gateways = await callSupabase(env, `/rest/v1/payment_gateways?key=eq.${encodeURIComponent(key)}&select=*`) as Record<string, unknown>[] | null;
			const gateway = gateways?.[0];
			if (!gateway) return errorResponse("Payment gateway not found", 404);
			const hasEnabled = typeof body.enabled === "boolean";
			const enabled = hasEnabled ? Boolean(body.enabled) : Boolean(gateway.enabled);
			if (hasEnabled && enabled && gateway.adapter_status !== "ready") return errorResponse(`${gateway.display_name} adapter is not implemented yet`, 409);
			const gatewayPatch: Record<string, unknown> = {};
			if (hasEnabled) gatewayPatch.enabled = enabled;
			if (body.environment === "sandbox" || body.environment === "production") gatewayPatch.environment = body.environment;
			if (typeof body.provider_key === "string") gatewayPatch.provider_key = body.provider_key.trim().toLowerCase();
			if (typeof body.account_label === "string") gatewayPatch.account_label = body.account_label.trim();
			if (Array.isArray(body.required_secrets)) gatewayPatch.required_secrets = body.required_secrets.map(value => String(value).trim().toUpperCase()).filter(Boolean);
			if (body.secret_values && typeof body.secret_values === "object") {
				const encrypted: Record<string, string> = {};
				for (const [name, value] of Object.entries(body.secret_values as Record<string, unknown>)) if (typeof value === "string" && value) encrypted[name] = await encryptConfigSecret(env, value);
				gatewayPatch.encrypted_secrets = { ...((gateway.encrypted_secrets || {}) as Record<string, string>), ...encrypted };
			}
			if (enabled) {
				await callSupabase(env, `/rest/v1/payment_gateways?key=neq.${encodeURIComponent(key)}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: false })
				});
			}
			await callSupabase(env, `/rest/v1/payment_gateways?key=eq.${encodeURIComponent(key)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(gatewayPatch)
			});
			if (enabled) {
				await callSupabase(env, "/rest/v1/flow_settings?id=eq.1", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ active_payment_key: key })
				});
			}
		}

		if (body.bot_key) {
			const key = String(body.bot_key);
			const bots = await callSupabase(env, `/rest/v1/telegram_bots?key=eq.${encodeURIComponent(key)}&select=*`) as Record<string, unknown>[] | null;
			const bot = bots?.[0];
			if (!bot) return errorResponse("Telegram bot not found", 404);
			const hasEnabled = typeof body.enabled === "boolean";
			const enabled = hasEnabled ? Boolean(body.enabled) : Boolean(bot.enabled);
			const botPatch: Record<string, unknown> = {};
			if (hasEnabled) botPatch.enabled = enabled;
			if (typeof body.username === "string") botPatch.username = body.username.trim().replace(/^@+/, "");
			if (typeof body.bot_id === "string") botPatch.bot_id = body.bot_id.trim();
			if (typeof body.webhook_path === "string") botPatch.webhook_path = body.webhook_path.trim();
			if (typeof body.purpose === "string") botPatch.purpose = body.purpose.trim();
			if (Array.isArray(body.required_secrets)) botPatch.required_secrets = body.required_secrets.map(value => String(value).trim().toUpperCase()).filter(Boolean);
			if (body.secret_values && typeof body.secret_values === "object") {
				const encrypted: Record<string, string> = {};
				for (const [name, value] of Object.entries(body.secret_values as Record<string, unknown>)) if (typeof value === "string" && value) encrypted[name] = await encryptConfigSecret(env, value);
				botPatch.encrypted_secrets = { ...((bot.encrypted_secrets || {}) as Record<string, string>), ...encrypted };
			}
			if (enabled) {
				await callSupabase(env, `/rest/v1/telegram_bots?key=neq.${encodeURIComponent(key)}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: false })
				});
			}
			await callSupabase(env, `/rest/v1/telegram_bots?key=eq.${encodeURIComponent(key)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(botPatch)
			});
			if (enabled) {
				await callSupabase(env, "/rest/v1/flow_settings?id=eq.1", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ active_telegram_key: key })
				});
			}
		}
		return handleIntegrationSettings(request, env);
	} catch (err) {
		return errorResponse(`Could not update integration settings: ${(err as Error).message}`, 500);
	}
}

async function encryptSecretValues(env: Env, input: unknown): Promise<Record<string, string>> {
	const encrypted: Record<string, string> = {};
	if (!input || typeof input !== "object") return encrypted;
	for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
		if (typeof value === "string" && value) encrypted[name] = await encryptConfigSecret(env, value);
	}
	return encrypted;
}

async function createIntegration(request: Request, env: Env): Promise<Response> {
	if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
	const body = await getBody(request) as Record<string, unknown> | null;
	if (!body) return errorResponse("Invalid JSON body");
	const key = String(body.key || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
	const displayName = String(body.display_name || "").trim();
	const providerKey = String(body.provider_key || "cashfree").trim().toLowerCase();
	const accountLabel = String(body.account_label || displayName || "Default account").trim();
	const requiredSecrets = Array.isArray(body.required_secrets)
		? body.required_secrets.map(value => String(value).trim().toUpperCase()).filter(Boolean)
		: [];
	if (!key || !displayName) return errorResponse("key and display_name are required");
	try {
		if (body.kind === "bot") {
			const botId = String(body.bot_id || "").trim();
			const username = String(body.username || "").trim().replace(/^@+/, "");
			const webhookPath = String(body.webhook_path || "").trim();
			const purpose = String(body.purpose || "Ticket booking").trim();
			if (!username || !webhookPath) return errorResponse("username and webhook_path are required");
			await callSupabase(env, "/rest/v1/telegram_bots", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
				body: JSON.stringify({ key, bot_id: botId, display_name: displayName, username, webhook_path: webhookPath, purpose, required_secrets: requiredSecrets, encrypted_secrets: await encryptSecretValues(env, body.secret_values), enabled: false })
			});
		} else {
			const environment = body.environment === "sandbox" ? "sandbox" : "production";
			await callSupabase(env, "/rest/v1/payment_gateways", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
				body: JSON.stringify({ key, provider_key: providerKey, account_label: accountLabel, display_name: displayName || accountLabel, environment, adapter_status: providerKey === "cashfree" ? "ready" : "planned", required_secrets: requiredSecrets, encrypted_secrets: await encryptSecretValues(env, body.secret_values), enabled: false })
			});
		}
		return handleIntegrationSettings(request, env);
	} catch (err) {
		return errorResponse(`Could not add integration: ${(err as Error).message}`, 409);
	}
}

async function deleteIntegration(request: Request, env: Env): Promise<Response> {
	if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
	const url = new URL(request.url);
	const kind = url.searchParams.get("kind") === "bot" ? "telegram_bots" : "payment_gateways";
	const key = url.searchParams.get("key");
	if (!key) return errorResponse("Integration key required");
	const active = await callSupabase(env, `/rest/v1/flow_settings?id=eq.1&select=active_payment_key,active_telegram_key`) as Record<string, unknown>[] | null;
	if (active?.[0]?.[kind === "telegram_bots" ? "active_telegram_key" : "active_payment_key"] === key) return errorResponse("Deactivate this integration before deleting it", 409);
	await callSupabase(env, `/rest/v1/${kind}?key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
	return handleIntegrationSettings(request, env);
}

async function isCashfreeFlowActive(env: Env): Promise<boolean> {
	try {
		const [flowRows] = await Promise.all([
			callSupabase(env, "/rest/v1/flow_settings?id=eq.1&select=active_payment_key,active_telegram_key")
		]);
		const flow = (flowRows as Record<string, unknown>[])?.[0];
		if (!flow) return true;
		const gateways = await callSupabase(env, `/rest/v1/payment_gateways?key=eq.${encodeURIComponent(String(flow.active_payment_key))}&select=provider_key,enabled,adapter_status`) as Record<string, unknown>[] | null;
		const bots = await callSupabase(env, `/rest/v1/telegram_bots?key=eq.${encodeURIComponent(String(flow.active_telegram_key))}&select=enabled`) as Record<string, unknown>[] | null;
		const gateway = gateways?.[0];
		const bot = bots?.[0];
		if (!flow || !gateway || !bot) return true;
		return gateway.provider_key === "cashfree"
			&& gateway.enabled === true
			&& gateway.adapter_status === "ready"
			&& bot.enabled === true;
	} catch {
		// Keep the existing flow working until the optional config migration runs.
		return true;
	}
}

// ================= SITE CONTENT =================

function getSiteContentTable(pathname: string): string | null {
	if (pathname === "/api/site-content") return "site_content";
	if (pathname === "/api/real-state-site-content" || pathname === "/api/real-estate-site-content") return "realstate_site_content";
	return null;
}

async function deleteImagesFromStorage(env: Env, imageUrls: string[]) {
	try {
		const filePaths = imageUrls.map(url => url.split("/storage/v1/object/public/")[1]);
		await fetch(`${env.SUPABASE_URL}/storage/v1/object/remove`, {
			method: "POST",
			headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({ bucket: "images", paths: filePaths })
		});
	} catch (err) { console.error("Image delete failed:", err); }
}

// ================= MAIN =================

export default {
	async fetch(request: Request, env: Env) {
		try {
			if (request.method === "OPTIONS") return new Response(null, { headers: cors });

			const url = new URL(request.url);
			const { pathname } = url;

			// public POST routes (no admin JWT needed)
			const isPublic =
				request.method === "GET" ||
				pathname === "/api/users/login" ||
				pathname === "/api/users/2fa/setup" ||
				pathname === "/api/users/2fa/verify-setup" ||
				pathname === "/api/user-auth/register" ||
				pathname === "/api/user-auth/login" ||
				pathname === "/bot/webhook" ||
				pathname === "/cf-bot/webhook" ||
				pathname === "/cashfree/webhook";

			if (!isPublic && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
				const admin = await verifyAdmin(request, env);
				if (!admin) return errorResponse("Unauthorized", 401);
			}

			// ── health ──
			if (pathname === "/" && request.method === "GET") return successResponse("API is running 🚀");

			// ── user auth ──
			if (pathname === "/api/user-auth/register" && request.method === "POST") return handleUserRegister(request, env);
			if (pathname === "/api/user-auth/login" && request.method === "POST") return handleUserLogin(request, env);
			if (pathname === "/api/user-auth/me" && request.method === "GET") return handleUserMe(request, env);
			if (pathname === "/api/user-auth/cf-tickets" && request.method === "GET") return handleUserCfTickets(request, env);

			// ── packages (public GET, admin POST/PATCH/DELETE) ──
			if (pathname === "/api/packages" && request.method === "GET") return handleGetPackages(env);

			if (pathname === "/api/packages" && request.method === "POST") {
				const body = (await getBody(request)) as Record<string, unknown>;
				if (!body?.name || !body?.stars || !body?.total_seats) return errorResponse("name, stars, total_seats required", 400);
				const seats = Number(body.total_seats);
				const pkg = await callSupabase(env, "/rest/v1/packages", {
					method: "POST",
					headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
					body: JSON.stringify({ name: body.name, description: body.description || null, stars: Number(body.stars), total_seats: seats, available_seats: seats, sort_order: body.sort_order || 0 })
				}) as Record<string, unknown>[] | null;
				const p = Array.isArray(pkg) ? pkg[0] : pkg;
				if (p && (p as Record<string, unknown>).id) {
					for (let i = 1; i <= seats; i++) {
						await callSupabase(env, "/rest/v1/seats", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ package_id: (p as Record<string, unknown>).id, seat_number: i })
						});
					}
				}
				return successResponse(p, "Package created", 201);
			}

			if (pathname.startsWith("/api/packages/") && request.method === "PATCH") {
				const id = pathname.split("/").pop();
				const body = await getBody(request);
				const result = await callSupabase(env, `/rest/v1/packages?id=eq.${id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
					body: JSON.stringify(body)
				});
				return successResponse(result, "Package updated");
			}

			if (pathname.startsWith("/api/packages/") && request.method === "DELETE") {
				const id = pathname.split("/").pop();
				await callSupabase(env, `/rest/v1/packages?id=eq.${id}`, { method: "DELETE" });
				return successResponse(null, "Package deleted");
			}

			// ── booking logs (admin) ──
			if (pathname === "/api/booking-logs" && request.method === "GET") {
				if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
				const data = await callSupabase(env, "/rest/v1/booking_logs?order=created_at.desc&limit=200&select=*");
				return successResponse(data, "Logs fetched");
			}

			// ── seat map (admin) ──
			if (pathname.startsWith("/api/seats/") && request.method === "GET") {
				if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
				const pkgId = pathname.split("/").pop();
				const data = await callSupabase(env, `/rest/v1/seats?package_id=eq.${pkgId}&order=seat_number.asc&select=*`);
				return successResponse(data, "Seat map fetched");
			}

			// ── Cashfree ticket bot webhook ──
			// Keep the old webhook path as an alias so an existing Telegram
			// webhook registration continues to deliver Cashfree updates.
			if (pathname === "/bot/webhook" && request.method === "POST") return handleCfBotWebhook(request, env);
			if (pathname === "/cf-bot/webhook" && request.method === "POST") return handleCfBotWebhook(request, env);

			// ── Cashfree payment webhook ──
			if (pathname === "/cashfree/webhook" && request.method === "POST") return handleCashfreeWebhook(request, env);

			// ── Cashfree payment checkout (auto-POST form to Cashfree) ──
			if (pathname === "/cf-payment/checkout" && request.method === "GET") return handleCfPaymentCheckout(url, env);

			// ── Cashfree payment return (browser redirect) ──
			if (pathname === "/cf-payment/return" && request.method === "GET") return handleCfPaymentReturn(url, env);

			// ── admin: CF tickets + orders ──
			if (pathname === "/api/cf-tickets" && request.method === "GET") return handleAdminCfTickets(request, env);
			if (pathname === "/api/cf-orders" && request.method === "GET") return handleAdminCfOrders(request, env);
			if (pathname === "/api/integrations" && request.method === "GET") return handleIntegrationSettings(request, env);
			if (pathname === "/api/integrations" && request.method === "POST") return createIntegration(request, env);
			if (pathname === "/api/integrations" && request.method === "PATCH") return updateIntegrationSettings(request, env);
			if (pathname === "/api/integrations" && request.method === "DELETE") return deleteIntegration(request, env);

			// ── admin users ──
			if (pathname === "/api/users/register" && request.method === "POST") {
				const body = (await getBody(request)) as Record<string, unknown> | null;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				if (!body.email || !body.username) return errorResponse("Username and email required");
				const result = await callSupabase(env, "/rest/v1/users", {
					method: "POST",
					headers: { "Content-Type": "application/json", "Prefer": "return=representation" },
					body: JSON.stringify({ username: body.username, email: body.email, role: body.role === "super_admin" ? "super_admin" : "admin" })
				});
				return successResponse(result, "Admin created successfully");
			}

			if (pathname === "/api/users/login" && request.method === "POST") {
				const body = (await request.json()) as Record<string, unknown>;
				if (!body.email || !body.token) return errorResponse("Email and token required");
				const res = await fetch(`${env.SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(body.email as string)}&role=in.(admin,super_admin)`, {
					headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` }
				});
				const users = JSON.parse(await res.text()) as Record<string, unknown>[];
				if (!users || users.length === 0) return errorResponse("User not found", 404);
				const user = users[0];
				if (!user.twoFactorSecret) return errorResponse("2FA not setup", 400);
				if (!authenticator.check(String(body.token), user.twoFactorSecret as string)) return errorResponse("Invalid OTP", 401);
				const secret = new TextEncoder().encode(env.JWT_SECRET);
				const token = await new SignJWT({ id: user.id, role: user.role }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("7d").sign(secret);
				const { twoFactorSecret: _s, ...safeUser } = user;
				return successResponse({ user: safeUser, token }, "Login successful");
			}

			if (pathname === "/api/users" && request.method === "GET") {
				if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
				const users = await callSupabase(env, "/rest/v1/users?select=*");
				return successResponse(users, "Users fetched successfully");
			}

			if (pathname.startsWith("/api/users/") && request.method === "GET" &&
				!pathname.includes("/2fa/") && pathname !== "/api/users/login" && pathname !== "/api/users/register") {
				const id = pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/users?id=eq.${id}`);
				return successResponse(result, "User fetched successfully");
			}

			if (pathname.startsWith("/api/users/") && request.method === "PATCH" &&
				!pathname.includes("/2fa/")) {
				const id = pathname.split("/").pop();
				const body = await getBody(request);
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				const result = await callSupabase(env, `/rest/v1/users?id=eq.${id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body)
				});
				return successResponse(result, "User updated successfully");
			}

			if (pathname === "/api/users/2fa/setup" && request.method === "POST") {
				const body = (await request.json()) as Record<string, unknown>;
				if (!body?.email) return errorResponse("Email required");
				const res = await fetch(`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } });
				const users = JSON.parse(await res.text()) as Record<string, unknown>[];
				if (!users?.length) return errorResponse("User not found", 404);
				const user = users[0];
				if (user.twoFactorEnabled) return errorResponse("2FA already enabled", 400);
				const tfSecret = authenticator.generateSecret();
				const otpauth_url = authenticator.keyuri(user.email as string, "DreamHome", tfSecret);
				await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`, {
					method: "PATCH",
					headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" },
					body: JSON.stringify({ twoFactorSecret: tfSecret })
				});
				return jsonResponse({ message: "Scan QR in Google Authenticator", data: { secret: tfSecret, otpauth_url } });
			}

			if (pathname === "/api/users/2fa/verify-setup" && request.method === "POST") {
				const body = (await request.json()) as Record<string, unknown>;
				if (!body?.email || !body?.token) return errorResponse("Email and token required");
				const res = await fetch(`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } });
				const users = JSON.parse(await res.text()) as Record<string, unknown>[];
				if (!users?.length) return errorResponse("User not found", 404);
				const user = users[0];
				if (!user.twoFactorSecret) return errorResponse("2FA not started", 400);
				if (!authenticator.check(String(body.token), user.twoFactorSecret as string)) return errorResponse("Invalid code", 400);
				await callSupabase(env, `/rest/v1/users?id=eq.${user.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ twoFactorEnabled: true }) });
				const secret = new TextEncoder().encode(env.JWT_SECRET);
				const token = await new SignJWT({ id: user.id, role: user.role }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("7d").sign(secret);
				return successResponse({ token }, "2FA enabled");
			}

			if (pathname === "/api/users/2fa/reset" && request.method === "POST") {
				const admin = await verifyAdmin(request, env);
				if (!admin) return errorResponse("Unauthorized", 401);
				const body = (await request.json()) as { email: string };
				if (!body?.email) return errorResponse("Email required", 400);
				const users = await callSupabase(env, `/rest/v1/users?email=eq.${encodeURIComponent(body.email)}`) as Record<string, unknown>[] | null;
				if (!users?.length) return errorResponse("User not found", 404);
				const user = users[0];
				const tfSecret = authenticator.generateSecret();
				const otpauth_url = authenticator.keyuri(user.email as string, "DreamHome", tfSecret);
				await callSupabase(env, `/rest/v1/users?id=eq.${user.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Prefer": "return=representation" }, body: JSON.stringify({ twoFactorSecret: tfSecret, twoFactorEnabled: false }) });
				return successResponse({ email: user.email, secret: tfSecret, otpauth_url }, "2FA reset successfully");
			}

			// ── products ──
			if (pathname === "/api/products" && request.method === "GET") {
				const data = await callSupabase(env, "/rest/v1/products?select=*");
				return successResponse(data, "Products fetched successfully");
			}
			if (pathname.startsWith("/api/products/category/")) {
				const category = pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/products?category=eq.${category}`);
				return successResponse(result, `Products in category ${category} fetched`);
			}
			if (pathname.startsWith("/api/products/") && request.method === "GET") {
				const id = pathname.split("/").pop();
				return successResponse(await callSupabase(env, `/rest/v1/products?id=eq.${id}`), "Product fetched");
			}
			if (pathname === "/api/products" && request.method === "POST") {
				const body = (await getBody(request)) as Record<string, unknown>;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				let images: string[] = [];
				if (Array.isArray(body.imageMeta) && body.imageMeta.length > 0) images = (body.imageMeta as Record<string, unknown>[]).map(img => img.url as string);
				else if (Array.isArray(body.images) && body.images.length > 0) images = body.images as string[];
				const product = await callSupabase(env, "/rest/v1/products", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ ...body, images }) });
				return successResponse((product as Record<string, unknown>[])?.[0] || product, "Product created successfully");
			}
			if (pathname.startsWith("/api/products/") && request.method === "PATCH") {
				const id = pathname.split("/").pop();
				const body = (await getBody(request)) as Record<string, unknown>;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				const updated = await callSupabase(env, `/rest/v1/products?id=eq.${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ ...body, images: Array.isArray(body.images) ? body.images : [] }) }) as Record<string, unknown>[] | null;
				if (!updated?.[0]) return errorResponse("Product not found", 404);
				return successResponse(updated[0], "Product updated successfully");
			}
			if (pathname.startsWith("/api/products/") && request.method === "DELETE") {
				const id = pathname.split("/").pop();
				if (!id) return errorResponse("Product ID required", 400);
				const existing = await callSupabase(env, `/rest/v1/products?id=eq.${id}&select=*`) as Record<string, unknown>[] | null;
				if (!existing?.[0]) return errorResponse("Product not found", 404);
				await callSupabase(env, `/rest/v1/products?id=eq.${id}`, { method: "DELETE" });
				if (existing[0].images) await deleteImagesFromStorage(env, existing[0].images as string[]);
				return successResponse(null, "Product deleted");
			}

			// ── properties ──
			if (pathname === "/api/properties" && request.method === "GET") return successResponse(await callSupabase(env, "/rest/v1/properties?select=*"), "Properties fetched");
			if (pathname.startsWith("/api/properties/") && request.method === "GET") return successResponse(await callSupabase(env, `/rest/v1/properties?id=eq.${pathname.split("/").pop()}`), "Property fetched");
			if (pathname === "/api/properties" && request.method === "POST") {
				const body = await getBody(request);
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				return successResponse(await callSupabase(env, "/rest/v1/properties", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), "Property created");
			}
			if (pathname.startsWith("/api/properties/") && request.method === "PATCH") {
				const body = await getBody(request);
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				return successResponse(await callSupabase(env, `/rest/v1/properties?id=eq.${pathname.split("/").pop()}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), "Property updated");
			}
			if (pathname.startsWith("/api/properties/") && request.method === "DELETE") {
				return successResponse(await callSupabase(env, `/rest/v1/properties?id=eq.${pathname.split("/").pop()}`, { method: "DELETE" }), "Property deleted");
			}

			// ── site content ──
			const siteContentTable = getSiteContentTable(pathname);
			if (siteContentTable) {
				const scp = `/rest/v1/${siteContentTable}?key=eq.main`;
				if (request.method === "GET") return successResponse(await callSupabase(env, `${scp}&select=*`), "Site content fetched");
				if (request.method === "POST") {
					const body = await getBody(request);
					if (!body) return errorResponse("Invalid or empty JSON body", 400);
					return successResponse(await callSupabase(env, `/rest/v1/${siteContentTable}`, { method: "POST", headers: { "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ key: "main", ...(body as object) }) }), "Site content created");
				}
				if (["PUT", "PATCH"].includes(request.method)) {
					const body = await getBody(request);
					if (!body) return errorResponse("Invalid or empty JSON body", 400);
					return successResponse(await callSupabase(env, scp, { method: "PATCH", headers: { "Content-Type": "application/json", "Prefer": "return=representation" }, body: JSON.stringify(body) }), "Site content updated");
				}
				if (request.method === "DELETE") return successResponse(await callSupabase(env, scp, { method: "DELETE", headers: { "Prefer": "return=representation" } }), "Site content deleted");
			}

			return errorResponse("Not Found", 404);

		} catch (err: unknown) {
			console.error("Unhandled error", err);
			if (err instanceof SupabaseRequestError) return errorResponse(err.message, err.status);
			return errorResponse("Unhandled error: " + (err as Error).message, 500);
		}
	}
};
