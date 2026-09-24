const toggle = document.getElementById('info-toggle');
const panel = document.getElementById('info-panel');

toggle.addEventListener('click', () => {
    const open = panel.style.display === 'block';
    panel.style.display = open ? 'none' : 'block';
    toggle.classList.toggle('active', !open);
});

// Close on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.style.display === 'block') {
        panel.style.display = 'none';
        toggle.classList.remove('active');
    }
});

// Close when clicking outside the panel and button
document.addEventListener('click', (e) => {
    if (!toggle.contains(e.target) && !panel.contains(e.target)) {
        panel.style.display = 'none';
        toggle.classList.remove('active');
    }
});