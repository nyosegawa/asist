// Fades each block in as it scrolls into view.
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in')
        io.unobserve(e.target)
      }
    }
  },
  { rootMargin: '0px 0px -8% 0px' }
)
for (const el of document.querySelectorAll('[data-in]')) io.observe(el)
