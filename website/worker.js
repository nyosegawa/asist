/** Sends www.asist-agent.com to the bare domain and serves the built page for everything else. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice('www.'.length)
      return Response.redirect(url.toString(), 301)
    }
    return env.ASSETS.fetch(request)
  }
}
