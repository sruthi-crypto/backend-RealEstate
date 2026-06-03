import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const env = {
	SUPABASE_URL: "https://supabase.test",
	SUPABASE_KEY: "service-key",
	JWT_SECRET: "jwt-secret"
};

async function adminAuthHeader() {
	const secret = new TextEncoder().encode(env.JWT_SECRET);
	const token = await new SignJWT({ id: 1, role: "admin" })
		.setProtectedHeader({ alg: "HS256" })
		.sign(secret);

	return `Bearer ${token}`;
}

describe("API worker", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns an API status response", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			message: "Success",
			data: "API is running 🚀"
		});
	});

	it("wraps properties list data in a Worker Response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(JSON.stringify([{ id: 1, title: "Villa" }]), {
				headers: { "Content-Type": "application/json" }
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("http://example.com/api/properties"),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://supabase.test/rest/v1/properties?select=*",
			expect.objectContaining({
				headers: expect.objectContaining({
					apikey: "service-key",
					Authorization: "Bearer service-key"
				})
			})
		);
		expect(await response.json()).toEqual({
			success: true,
			message: "Properties fetched successfully",
			data: [{ id: 1, title: "Villa" }]
		});
	});

	it("returns a useful error when Supabase sends non-JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response("<html>Not Found</html>", {
					status: 404,
					statusText: "Not Found",
					headers: { "Content-Type": "text/html" }
				});
			})
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("http://example.com/api/properties"),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			success: false,
			message:
				"Unhandled error: Invalid JSON from Supabase (404 Not Found, text/html): <html>Not Found</html>"
		});
	});

	it("returns 400 for invalid register JSON", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("http://example.com/api/users/register", {
				method: "POST",
				body: "{"
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			message: "Invalid or empty JSON body"
		});
	});

	it("preserves Supabase conflict status during register", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({ message: "duplicate key value violates unique constraint" }),
					{
						status: 409,
						statusText: "Conflict",
						headers: { "Content-Type": "application/json" }
					}
				);
			})
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("http://example.com/api/users/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "test@example.com" })
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			success: false,
			message:
				"Supabase 409 Conflict: duplicate key value violates unique constraint"
		});
	});

	it("updates site content through the real-state alias", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(JSON.stringify([{ key: "main", heroTitle: "Updated" }]), {
				headers: { "Content-Type": "application/json" }
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("http://example.com/api/real-state-site-content", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: await adminAuthHeader()
				},
				body: JSON.stringify({ heroTitle: "Updated" })
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://supabase.test/rest/v1/site_content?key=eq.main",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ heroTitle: "Updated" })
			})
		);
		expect(await response.json()).toEqual({
			success: true,
			message: "Site content updated successfully",
			data: [{ key: "main", heroTitle: "Updated" }]
		});
	});

	it("fetches site content through the real-estate alias", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(JSON.stringify([{ key: "main" }]), {
					headers: { "Content-Type": "application/json" }
				});
			})
		);

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("http://example.com/api/real-estate-site-content"),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			message: "Site content fetched successfully",
			data: [{ key: "main" }]
		});
	});
});
