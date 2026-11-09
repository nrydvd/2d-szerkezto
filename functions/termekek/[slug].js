export function onRequestGet({ request, env, params, next }) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(params.slug)) return next();
  const url = new URL(request.url);
  url.pathname = "/termekek/";
  return env.ASSETS.fetch(new Request(url, request));
}
