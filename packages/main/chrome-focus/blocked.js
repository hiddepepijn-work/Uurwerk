// Fills in the task name from the service worker, and says so once focus is over.
const show = (state) => {
  if (!state) return
  if (state.focus) {
    if (state.task) document.getElementById('task').textContent = state.task
  } else {
    document.querySelector('h1').textContent = 'Focus is voorbij'
    document.getElementById('line').textContent = 'X en YouTube staan weer aan.'
  }
}

const ask = () => chrome.runtime.sendMessage('state').then(show, () => {})
ask()
setInterval(ask, 10_000)
