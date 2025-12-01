
const form = document.getElementById('name-form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('appName');
  const value = input.value.trim();
  const res = await fetch('/set-name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName: value })
  });
  const data = await res.json();
  if (data.ok) {
    // Reload to show the new title and heading
    location.reload();
  } else {
    alert('Failed: ' + (data.error || 'Unknown error'));
  }
});
