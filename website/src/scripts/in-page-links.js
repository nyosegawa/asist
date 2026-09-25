// Scrolls to a section without writing its #id into the address, so the landing page keeps a bare URL.
// A click with a modifier key is left to the browser, which opens the link as it usually does.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.target.closest('a[href^="#"]')
  const target = link && document.getElementById(link.getAttribute('href').slice(1))
  if (!target) return
  event.preventDefault()
  target.scrollIntoView()
})
