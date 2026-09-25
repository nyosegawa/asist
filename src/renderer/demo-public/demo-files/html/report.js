// Draws the bar chart of seats per dollar, the part of the report that only a script can produce.
const rows = [
  { name: 'A', value: 5 / 20 },
  { name: 'B', value: 20 / 35 },
  { name: 'C', value: 2 / 12 }
]
const canvas = document.getElementById('seats')
const ctx = canvas.getContext('2d')
const max = Math.max(...rows.map((row) => row.value))
const barHeight = 40
ctx.font = '14px -apple-system, sans-serif'
ctx.textBaseline = 'middle'
rows.forEach((row, i) => {
  const y = 20 + i * (barHeight + 20)
  const width = (row.value / max) * 420
  ctx.fillStyle = '#1f2933'
  ctx.fillText(row.name, 0, y + barHeight / 2)
  ctx.fillStyle = ['#3b82f6', '#10b981', '#f59e0b'][i]
  ctx.fillRect(30, y, width, barHeight)
  ctx.fillStyle = '#1f2933'
  ctx.fillText(row.value.toFixed(2), 40 + width, y + barHeight / 2)
})
