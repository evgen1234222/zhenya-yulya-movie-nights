// Cloudflare Worker for "Наш кинозал".
// Deploy this file to the Worker named our-cinema-api.
// Configure the KINOPOISK_API_KEY as a Secret (never paste the key in this file).
const SITE_ORIGIN = "https://evgen1234222.github.io";
const API = "https://kinopoiskapiunofficial.tech";

function json(value, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": SITE_ORIGIN,
      "Vary": "Origin",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function nameOf(film) {
  return film.nameRu || film.nameOriginal || film.nameEn || "Без названия";
}

function genresOf(film) {
  return (film.genres || []).map(item => item.genre).filter(Boolean);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== SITE_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": SITE_ORIGIN,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      }});
    }
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true, service: "Наш кинозал — поиск фильмов" });
    if (!env.KINOPOISK_API_KEY) return json({ error: "API key is not configured" }, 503);

    let upstream;
    let kind;
    if (url.pathname === "/search") {
      const query = (url.searchParams.get("q") || "").trim();
      if (query.length < 2 || query.length > 80) return json({ error: "Query length must be 2–80 characters" }, 400);
      upstream = `${API}/api/v2.1/films/search-by-keyword?keyword=${encodeURIComponent(query)}&page=1`;
      kind = "search";
    } else if (/^\/film\/\d{1,12}$/.test(url.pathname)) {
      upstream = `${API}/api/v2.2/films/${url.pathname.split("/")[2]}`;
      kind = "film";
    } else {
      return json({ error: "Not found" }, 404);
    }

    // Cache popular searches and details to protect the upstream quota.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const response = await fetch(upstream, {
        headers: { "X-API-KEY": env.KINOPOISK_API_KEY, "Accept": "application/json" },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) {
        if (response.status === 429 || response.status === 402)
          return json({ error: "Лимит запросов Кинопоиска исчерпан. Попробуйте позже." }, 429);
        return json({ error: "Кинопоиск временно недоступен", upstreamStatus: response.status }, 502);
      }
      const data = await response.json();
      let payload;
      if (kind === "search") {
        payload = { items: (data.films || []).slice(0, 12).map(f => ({
          id: f.filmId,
          title: nameOf(f),
          year: f.year || "",
          genre: genresOf(f).slice(0, 2).join(", "),
          poster: f.posterUrlPreview || f.posterUrl || "",
          ratingKP: f.rating || ""
        })).filter(f => Number.isInteger(f.id)) };
      } else {
        payload = {
          id: data.kinopoiskId || data.filmId,
          title: nameOf(data),
          year: data.year || "",
          genre: genresOf(data).slice(0, 3).join(", "),
          poster: data.posterUrl || data.posterUrlPreview || "",
          ratingKP: data.ratingKinopoisk || "",
          description: data.description || data.shortDescription || ""
        };
      }
      const result = json(payload, 200, kind === "search" ? 3600 : 86400);
      await cache.put(cacheKey, result.clone());
      return result;
    } catch (error) {
      return json({ error: "Не удалось связаться с Кинопоиском" }, 502);
    }
  }
};
