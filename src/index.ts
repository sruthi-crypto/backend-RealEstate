import { SignJWT } from "jose";
import { authenticator } from "otplib";
import { jwtVerify } from "jose";
const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization"
};

type Env = {
	SUPABASE_URL: string;
	SUPABASE_KEY: string;
	JWT_SECRET: string;
};

class SupabaseRequestError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SupabaseRequestError";
		this.status = status;
	}
}

// ================= RESPONSE HELPERS =================

function jsonResponse(body: any, status = 200) {
	return new Response(JSON.stringify(body), {
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

		return payload; // ✅ valid user
	} catch {
		return null;
	}
}

// ================= SUPABASE CALL =================

async function callSupabase(env: Env, path: string, init?: RequestInit) {
	try {
		if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
			throw new Error("Supabase configuration missing");
		}

		const res = await fetch(`${env.SUPABASE_URL}${path}`, {
			...init,
			headers: {
				apikey: env.SUPABASE_KEY,
				Authorization: `Bearer ${env.SUPABASE_KEY}`,
				...(init?.headers || {})
			}
		});

		//  handle NO CONTENT (DELETE, etc.)
		if (res.status === 204) {
			return null;
		}

		const text = await res.text();
		const contentType = res.headers.get("Content-Type") || "unknown";

		//  empty response safety
		if (!text) {
			if (!res.ok) {
				throw new Error(`Supabase ${res.status} ${res.statusText}`);
			}
			return null;
		}

		//  parse safely
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			const preview = text.replace(/\s+/g, " ").slice(0, 180);
			throw new Error(
				`Invalid JSON from Supabase (${res.status} ${res.statusText}, ${contentType}): ${preview}`
			);
		}

		if (!res.ok) {
			const message =
				typeof data?.message === "string"
					? data.message
					: typeof data?.msg === "string"
						? data.msg
						: JSON.stringify(data);
			throw new SupabaseRequestError(
				`Supabase ${res.status} ${res.statusText}: ${message}`,
				res.status
			);
		}

		return data;
	} catch (err: any) {
		if (err instanceof SupabaseRequestError) {
			throw err;
		}

		// don't return Response here
		throw new Error(err.message || "Supabase request failed");
	}
}

async function getBody(request: Request) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

type LoginBody = {
	email: string;
	token: string;
};

function isSiteContentPath(pathname: string) {
	return [
		"/api/site-content",
		"/api/real-state-site-content",
		"/api/real-estate-site-content"
	].includes(pathname);
}

function getSiteContentTable(pathname: string) {
	if (pathname === "/api/site-content") {
		return "site_content";
	}

	if (
		pathname === "/api/real-state-site-content" ||
		pathname === "/api/real-estate-site-content"
	) {
		return "realstate_site_content";
	}

	return null;
}

function successResponse(data: any, message = "Success", status = 200) {
	return new Response(
		JSON.stringify({
			success: true,
			message,
			data
		}),
		{
			status,
			headers: { ...cors, "Content-Type": "application/json" }
		}
	);
}

function errorResponse(message: string, status = 400) {
	return new Response(
		JSON.stringify({
			success: false,
			message
		}),
		{
			status,
			headers: { ...cors, "Content-Type": "application/json" }
		}
	);
}

// ------------------images delete -------------------------

async function deleteImagesFromStorage(env: Env, imageUrls: string[]) {
	try {
		const filePaths = imageUrls.map((url) => {
			const parts = url.split("/storage/v1/object/public/");
			return parts[1]; // extract path
		});

		await fetch(`${env.SUPABASE_URL}/storage/v1/object/remove`, {
			method: "POST",
			headers: {
				apikey: env.SUPABASE_KEY,
				Authorization: `Bearer ${env.SUPABASE_KEY}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				bucket: "images",
				paths: filePaths
			})
		});
	} catch (err) {
		console.error("Image delete failed:", err);
	}
}
// ================= MAIN =================

export default {
	async fetch(request: Request, env: Env) {
		try {
			if (request.method === "OPTIONS") {
				return new Response(null, { headers: cors });
			}

			const url = new URL(request.url);

			// ================= AUTH PROTECTION =================

			const isPublic =
				request.method === "GET" ||
				url.pathname === "/api/users/login" ||
				url.pathname === "/api/users/register" ||
				url.pathname === "/api/users/2fa/setup" ||
				url.pathname === "/api/users/2fa/verify-setup";

			if (!isPublic && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
				const admin = await verifyAdmin(request, env);
				if (!admin) return errorResponse("Unauthorized", 401);
			}

			// ================= USERS =================
			if (url.pathname === "/" && request.method === "GET") {
				return successResponse("API is running 🚀");
			}
			if (url.pathname === "/api/users/register" && request.method === "POST") {
				const body = (await getBody(request)) as Record<string, any> | null;
				if (!body) return errorResponse("Invalid or empty JSON body", 400);
				if (!body.email) return errorResponse("Email required");

				const result = await callSupabase(env, "/rest/v1/users", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Prefer": "return=representation"
					},
					body: JSON.stringify(body)
				});
				return successResponse(result, "User created successfully");
			}

			if (url.pathname === "/api/users/login" && request.method === "POST") {
				const body = (await request.json()) as Record<string, any>;
				if (!body.email || !body.token) {
					return errorResponse("Email and token required");
				}

				const res = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`,
					{
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`
						}
					}
				);

				const text = await res.text();

				let users;
				try {
					users = JSON.parse(text);
				} catch {
					return errorResponse("Invalid DB response", 500);
				}

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];

				if (!user.twoFactorSecret) {
					return errorResponse("2FA not setup", 400);
				}
				if (!env.JWT_SECRET) {
					return errorResponse("JWT_SECRET missing", 500);
				}
				const verified = authenticator.check(
					String(body.token),
					user.twoFactorSecret
				);

				if (!verified) return errorResponse("Invalid OTP", 401);
				if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
					return errorResponse("JWT_SECRET invalid", 500);
				}
				const secret = new TextEncoder().encode(env.JWT_SECRET);

				const token = await new SignJWT({ id: user.id, role: user.role })
					.setProtectedHeader({ alg: "HS256" })
					.setExpirationTime("7d")
					.sign(secret);

				const { twoFactorSecret, ...safeUser } = user;

				return successResponse(
					{
						user: safeUser,
						token
					},
					"Login successful"
				);
			}

			if (url.pathname === "/api/users" && request.method === "GET") {
				const users = await callSupabase(env, "/rest/v1/users?select=*");
				return successResponse(users, "Users fetched successfully");
			}

			if (url.pathname.startsWith("/api/users/") && request.method === "GET") {
				const id = url.pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/users?id=eq.${id}`);
				return successResponse(result, "User fetched successfully");
			}

			if (url.pathname.startsWith("/api/users/") && request.method === "PATCH") {
				const id = url.pathname.split("/").pop();
				const body = await getBody(request);

				if (!body) {
					return errorResponse("Invalid or empty JSON body", 400);
				}
				const result = await callSupabase(env, `/rest/v1/users?id=eq.${id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body)
				});
				return successResponse(result, "User updated successfully");
			}
			if (url.pathname === "/api/users/2fa/setup" && request.method === "POST") {
				const body = (await request.json()) as LoginBody;
				if (!body || !body.email) {
					return errorResponse("Email required");
				}

				// get user
				const res = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`,
					{
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`
						}
					}
				);

				const text = await res.text();
				let users;

				try {
					users = JSON.parse(text);
				} catch {
					return errorResponse("Invalid DB response", 500);
				}

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];

				if (user.twoFactorEnabled) {
					return errorResponse("2FA already enabled", 400);
				}

				// generate secret
				const secret = authenticator.generateSecret();

				const otpauth_url = authenticator.keyuri(
					user.email,
					"Jewelry",
					secret
				);

				// save secret
				const updateRes = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`,
					{
						method: "PATCH",
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`,
							"Content-Type": "application/json",
							"Prefer": "return=representation"
						},
						body: JSON.stringify({
							twoFactorSecret: (secret)
						})
					}
				);

				const updateText = await updateRes.text();

				// 🔍 DEBUG (VERY IMPORTANT)
				if (!updateText) {
					return errorResponse("Failed to save 2FA secret (empty response)", 500);
				}

				let updatedUser;
				try {
					updatedUser = JSON.parse(updateText);
				} catch {
					return errorResponse("Invalid DB response while saving 2FA", 500);
				}

				if (!updatedUser || updatedUser.length === 0) {
					return errorResponse("2FA secret not saved in DB", 500);
				}

				return jsonResponse({
					message: "Scan QR in Google Authenticator",
					data: {
						secret: secret,
						otpauth_url: otpauth_url
					}
				});
			}
			if (url.pathname === "/api/users/2fa/verify-setup" && request.method === "POST") {
				const body = (await request.json()) as LoginBody;
				if (!body || !body.email || !body.token) {
					return errorResponse("Email and token required");
				}

				const res = await fetch(
					`${env.SUPABASE_URL}/rest/v1/users?email=eq.${body.email}`,
					{
						headers: {
							apikey: env.SUPABASE_KEY,
							Authorization: `Bearer ${env.SUPABASE_KEY}`
						}
					}
				);

				const text = await res.text();
				let users;

				try {
					users = JSON.parse(text);
				} catch {
					return errorResponse("Invalid DB response", 500);
				}

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];

				if (!user.twoFactorSecret) {
					return errorResponse("2FA not started", 400);
				}


				const verified = authenticator.check(
					String(body.token),
					user.twoFactorSecret
				);

				if (!verified) {
					return errorResponse("Invalid code", 400);
				}

				// enable 2FA
				await callSupabase(
					env,
					`/rest/v1/users?id=eq.${user.id}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							twoFactorEnabled: true
						})
					}
				);

				if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
					return errorResponse("JWT_SECRET invalid", 500);
				}
				const secret = new TextEncoder().encode(env.JWT_SECRET);

				const token = await new SignJWT({ id: user.id, role: user.role })
					.setProtectedHeader({ alg: "HS256" })
					.setExpirationTime("7d")
					.sign(secret);

				return successResponse(
					{ token },
					"2FA enabled"
				);
			}

			if (url.pathname === "/api/users/2fa/reset" && request.method === "POST") {
				const admin = await verifyAdmin(request, env);

				if (!admin) {
					return errorResponse("Unauthorized", 401);
				}

				if (admin.role !== "admin" && admin.role !== "super_admin") {
					return errorResponse("Only admin can reset 2FA", 403);
				}

				const body = (await request.json()) as { email: string };

				if (!body?.email) {
					return errorResponse("Email required", 400);
				}

				const users = await callSupabase(
					env,
					`/rest/v1/users?email=eq.${encodeURIComponent(body.email)}`
				);

				if (!users || users.length === 0) {
					return errorResponse("User not found", 404);
				}

				const user = users[0];
				const secret = authenticator.generateSecret();
				const otpauth_url = authenticator.keyuri(
					user.email,
					"Jewelry",
					secret
				);

				await callSupabase(
					env,
					`/rest/v1/users?id=eq.${user.id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							"Prefer": "return=representation"
						},
						body: JSON.stringify({
							twoFactorSecret: secret,
							twoFactorEnabled: false // IMPORTANT
						})
					}
				);

				return successResponse(
					{
						email: user.email,
						secret,
						otpauth_url
					},
					"2FA reset successfully. Verify again using /api/users/2fa/verify-setup"
				);
			}
			// ================= PRODUCTS =================

			if (url.pathname === "/api/products" && request.method === "GET") {
				if (url.pathname === "/api/products" && request.method === "GET") {
					const data = await callSupabase(env, "/rest/v1/products?select=*");

					return successResponse(data, "Products fetched successfully");
				}
			}

			if (url.pathname.startsWith("/api/products/category/")) {
				const category = url.pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/products?category=eq.${category}`);
				return successResponse(result, `Products in category ${category} fetched successfully`);
			}

			if (url.pathname.startsWith("/api/products/") && request.method === "GET") {
				const id = url.pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/products?id=eq.${id}`);
				return successResponse(result, "Product fetched successfully");
			}
			if (url.pathname === "/api/products" && request.method === "POST") {
				const body = (await getBody(request)) as Record<string, any>;

				if (!body) {
					return errorResponse("Invalid or empty JSON body", 400);
				}

				let images: string[] = [];

				if (Array.isArray(body.imageMeta) && body.imageMeta.length > 0) {
					images = body.imageMeta.map((img: any) => img.url);
				}

				else if (Array.isArray(body.images) && body.images.length > 0) {
					images = body.images;
				}

				const productPayload = {
					...body,
					images
				};

				const product = await callSupabase(env, "/rest/v1/products", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Prefer: "return=representation"
					},
					body: JSON.stringify(productPayload)
				});

				return successResponse(
					product?.[0] || product,
					"Product created successfully"
				);
			}

			if (url.pathname.startsWith("/api/products/") && request.method === "PATCH") {
				const id = url.pathname.split("/").pop();
				const body = (await getBody(request)) as Record<string, any>;

				if (!body) {
					return errorResponse("Invalid or empty JSON body", 400);
				}

				// normalize images (important)
				const updatedPayload = {
					...body,
					images: Array.isArray(body.images)
						? body.images
						: []
				};

				// 🟢 update in Supabase
				const updated = await callSupabase(
					env,
					`/rest/v1/products?id=eq.${id}`,
					{
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							Prefer: "return=representation" //IMPORTANT
						},
						body: JSON.stringify(updatedPayload)
					}
				);

				const product = updated?.[0];

				if (!product) {
					return errorResponse("Product not found", 404);
				}

				//final response (same as old API)
				return successResponse(product, "Product updated successfully");
			}

			if (url.pathname.startsWith("/api/products/") && request.method === "DELETE") {
				const id = url.pathname.split("/").pop();

				if (!id) {
					return errorResponse("Product ID required", 400);
				}

				try {
					// get product (for images)
					const existing = await callSupabase(
						env,
						`/rest/v1/products?id=eq.${id}&select=*`
					);

					const product = existing?.[0];

					if (!product) {
						return errorResponse("Product not found", 404);
					}

					// delete product
					await callSupabase(env, `/rest/v1/products?id=eq.${id}`, {
						method: "DELETE"
					});

					// optional: delete images
					if (product.images) {
						await deleteImagesFromStorage(env, product.images);
					}

					return successResponse(null, "Product deleted");
				} catch (err: any) {
					return errorResponse(err.message, 500);
				}
			}

			// ================= PROPERTIES =================

			if (url.pathname === "/api/properties" && request.method === "GET") {
				const result = await callSupabase(env, "/rest/v1/properties?select=*");
				return successResponse(result, "Properties fetched successfully");
			}

			if (url.pathname.startsWith("/api/properties/") && request.method === "GET") {
				const id = url.pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/properties?id=eq.${id}`);
				return successResponse(result, "Property fetched successfully");
			}

			if (url.pathname === "/api/properties" && request.method === "POST") {
				const body = await getBody(request);

				if (!body) {
					return errorResponse("Invalid or empty JSON body", 400);
				}
				const result = await callSupabase(env, "/rest/v1/properties", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body)
				});
				return successResponse(result, "Property created successfully");
			}

			if (url.pathname.startsWith("/api/properties/") && request.method === "PATCH") {
				const id = url.pathname.split("/").pop();
				const body = await getBody(request);

				if (!body) {
					return errorResponse("Invalid or empty JSON body", 400);
				}
				const result = await callSupabase(env, `/rest/v1/properties?id=eq.${id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body)
				});
				return successResponse(result, "Property updated successfully");
			}

			if (url.pathname.startsWith("/api/properties/") && request.method === "DELETE") {
				const id = url.pathname.split("/").pop();
				const result = await callSupabase(env, `/rest/v1/properties?id=eq.${id}`, {
					method: "DELETE"
				});
				return successResponse(result, "Property deleted successfully");
			}

			// ================= SITE CONTENT =================

			const siteContentTable = getSiteContentTable(url.pathname);
			if (siteContentTable) {
				const siteContentPath = `/rest/v1/${siteContentTable}?key=eq.main`;

				if (request.method === "GET") {
					const result = await callSupabase(env, `${siteContentPath}&select=*`);
					return successResponse(result, "Site content fetched successfully");
				}

				if (request.method === "POST") {
					const body = await getBody(request);

					if (!body) {
						return errorResponse("Invalid or empty JSON body", 400);
					}

					const result = await callSupabase(env, `/rest/v1/${siteContentTable}`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Prefer": "resolution=merge-duplicates,return=representation"
						},
						body: JSON.stringify({
							key: "main",
							...(body as Record<string, any>)
						})
					});
					return successResponse(result, "Site content created successfully");
				}

				if (["PUT", "PATCH"].includes(request.method)) {
					const body = await getBody(request);

					if (!body) {
						return errorResponse("Invalid or empty JSON body", 400);
					}
					const result = await callSupabase(env, siteContentPath, {
						method: "PATCH",
						headers: {
							"Content-Type": "application/json",
							"Prefer": "return=representation"
						},
						body: JSON.stringify(body)
					});
					return successResponse(result, "Site content updated successfully");
				}

				if (request.method === "DELETE") {
					const result = await callSupabase(env, siteContentPath, {
						method: "DELETE",
						headers: {
							"Prefer": "return=representation"
						}
					});
					return successResponse(result, "Site content deleted successfully");
				}
			}
			return errorResponse("Not Found", 404);

		} catch (err: any) {
			console.error("Unhandled error", err);
			if (err instanceof SupabaseRequestError) {
				return errorResponse(err.message, err.status);
			}

			return errorResponse("Unhandled error: " + err.message, 500);
		}
	}
};
