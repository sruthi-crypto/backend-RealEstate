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
	const date = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
	return `ORD-${date}-${String(seq).padStart(4,"0")}`;
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
	await bookingLog(env, (order as Record<string,unknown>)?.id as string, null, "order_created", true,
		`package=${pkg.name} stars=${pkg.stars} user=${userPhone}`);

	const botUsername = env.BOT_USERNAME || "";
	const deepLink = `https://t.me/${botUsername}?start=${orderId}`;
	return successResponse({ order, deep_link: deepLink }, "Order created", 201);
}

// POST /bot/webhook — Telegram bot webhook
async function handleBotWebhook(request: Request, env: Env): Promise<Response> {
	let update: Record<string, unknown>;
	try { update = await request.json() as Record<string, unknown>; }
	catch { return new Response("ok"); }

	const message = update.message as Record<string, unknown> | undefined;
	const preCheckout = update.pre_checkout_query as Record<string, unknown> | undefined;

	// ── /start <ORDER_ID> ──
	if (message) {
		const chatId = (message.chat as Record<string, unknown>)?.id as number;
		const fromId = (message.from as Record<string, unknown>)?.id as number;
		const fromUsername = (message.from as Record<string, unknown>)?.username as string | undefined;
		const text = message.text as string | undefined;

		if (text?.startsWith("/start")) {
			const parts = text.split(" ");
			const orderId = parts[1]?.trim();

			if (!orderId || !orderId.startsWith("ORD-")) {
				await sendTgMessage(env, chatId, "👋 Welcome! Visit the website to browse property packages.");
				return new Response("ok");
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
				const lines = tickets.map(t => `🎫 ${t.ticket_number} — ⭐${t.stars} — ${String(t.issued_at).slice(0,10)}`).join("\n");
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
		if (tCheck && tCheck.length > 0) ticketNumber = generateTicketNumber() + Math.floor(Math.random()*9);

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
				ticket_id: (ticket as Record<string,unknown>)?.id,
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
				pathname === "/bot/webhook";

			if (!isPublic && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
				// user-auth/me is GET so already public; orders needs user JWT not admin
				if (pathname !== "/api/orders") {
					const admin = await verifyAdmin(request, env);
					if (!admin) return errorResponse("Unauthorized", 401);
				}
			}

			// ── health ──
			if (pathname === "/" && request.method === "GET") return successResponse("API is running 🚀");

			// ── user auth ──
			if (pathname === "/api/user-auth/register" && request.method === "POST") return handleUserRegister(request, env);
			if (pathname === "/api/user-auth/login"    && request.method === "POST") return handleUserLogin(request, env);
			if (pathname === "/api/user-auth/me"       && request.method === "GET")  return handleUserMe(request, env);
			if (pathname === "/api/user-auth/tickets"  && request.method === "GET")  return handleUserTickets(request, env);

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
				if (p && (p as Record<string,unknown>).id) {
					for (let i = 1; i <= seats; i++) {
						await callSupabase(env, "/rest/v1/seats", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ package_id: (p as Record<string,unknown>).id, seat_number: i })
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

			// ── orders ──
			if (pathname === "/api/orders" && request.method === "POST") return handleCreateOrder(request, env);

			if (pathname === "/api/orders" && request.method === "GET") {
				if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
				const data = await callSupabase(env, "/rest/v1/orders?order=created_at.desc&select=*");
				return successResponse(data, "Orders fetched");
			}

			// ── payments (admin) ──
			if (pathname === "/api/payments" && request.method === "GET") {
				if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
				const data = await callSupabase(env, "/rest/v1/payments?order=paid_at.desc&select=*");
				return successResponse(data, "Payments fetched");
			}

			// ── tickets (admin) ──
			if (pathname === "/api/tickets" && request.method === "GET") {
				if (!(await verifyAdmin(request, env))) return errorResponse("Unauthorized", 401);
				const data = await callSupabase(env, "/rest/v1/tickets?order=issued_at.desc&select=*");
				return successResponse(data, "Tickets fetched");
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

			// ── bot webhook ──
			if (pathname === "/bot/webhook" && request.method === "POST") return handleBotWebhook(request, env);

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
				if (Array.isArray(body.imageMeta) && body.imageMeta.length > 0) images = (body.imageMeta as Record<string,unknown>[]).map(img => img.url as string);
				else if (Array.isArray(body.images) && body.images.length > 0) images = body.images as string[];
				const product = await callSupabase(env, "/rest/v1/products", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ ...body, images }) });
				return successResponse((product as Record<string,unknown>[])?.[0] || product, "Product created successfully");
			}
			if (pathname.startsWith("/api/products/") && request.method === "PATCH") {
				const id = pathname.split("/").pop();
				const body = (await getBody(request)) as Record<string, unknown>;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				const updated = await callSupabase(env, `/rest/v1/products?id=eq.${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ ...body, images: Array.isArray(body.images) ? body.images : [] }) }) as Record<string,unknown>[] | null;
				if (!updated?.[0]) return errorResponse("Product not found", 404);
				return successResponse(updated[0], "Product updated successfully");
			}
			if (pathname.startsWith("/api/products/") && request.method === "DELETE") {
				const id = pathname.split("/").pop();
				if (!id) return errorResponse("Product ID required", 400);
				const existing = await callSupabase(env, `/rest/v1/products?id=eq.${id}&select=*`) as Record<string,unknown>[] | null;
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
