'use strict';

const path = require('path');
const express = require('express');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'srt-timeline-trimmer', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`字幕时间轴修整器已启动: http://localhost:${PORT}`);
});
