/** Sends every request to www.asist-agent.com to the same path on the bare domain. */
export default {
  fetch(request) {
    const url = new URL(request.url)
    url.hostname = 'asist-agent.com'
    return Response.redirect(url.toString(), 301)
  }
}
