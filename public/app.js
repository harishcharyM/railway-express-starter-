
const uploadForm = document.getElementById('upload-form');
const uploadResult = document.getElementById('upload-result');
if (uploadForm && uploadResult) {
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(uploadForm); // expects input name="file"
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    uploadResult.textContent = data.ok
      ? `Uploaded: ${data.filename} (${data.size} bytes) → ${data.url}`
      : 'Upload failed: ' + (data.error || 'Unknown error');
  });
}
