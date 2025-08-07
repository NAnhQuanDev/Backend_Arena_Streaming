const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const app = express();

app.use(express.urlencoded({ extended: true })); // Cho webhook on_done
app.use(express.json()); // Cho REST API

const runningWorkers = {}; // matchid => {proc, output_url}

function overlayPath(matchid) {
    return `/tmp/overlay_${matchid}.txt`;
}

// 1. API khởi tạo live (phải truyền đủ matchid, url, streamkey, overlay khởi tạo)
app.post('/startlive', (req, res) => {
    const { matchid, url, streamkey, score = 0, name = '' } = req.body;
    if (!matchid || !url || !streamkey) return res.status(400).json({ error: 'Thiếu tham số' });

    if (runningWorkers[matchid]) return res.json({ message: 'Worker đã chạy!' });

    fs.writeFileSync(overlayPath(matchid), `SCORE: ${score}\nNAME: ${name}`, 'utf8');
    const output_url = `${url}/${streamkey}`;
    const ffmpegArgs = [
        '-re', '-i', `rtmp://localhost:1935/live/${matchid}`,
        '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${overlayPath(matchid)}:reload=1:x=100:y=50:fontsize=48:fontcolor=white:borderw=2:bordercolor=black`,
        '-c:v', 'libx264', '-c:a', 'copy', '-f', 'flv', output_url
    ];
    console.log(`[${matchid}] Spawn ffmpeg: ${ffmpegArgs.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stdout.on('data', d => console.log(`[${matchid}] ${d}`));
    ffmpeg.stderr.on('data', d => console.log(`[${matchid}] ${d}`));
    ffmpeg.on('close', code => {
        console.log(`[${matchid}] FFmpeg exited`);
        delete runningWorkers[matchid];
    });

    runningWorkers[matchid] = { proc: ffmpeg, output_url };
    res.json({ message: 'Đã start live!', ffmpegArgs });
});

// 2. API cập nhật overlay động
app.post('/updateoverlay', (req, res) => {
    const { matchid, score, name } = req.body;
    if (!matchid) return res.status(400).json({ error: 'Thiếu matchid' });
    const text = `SCORE: ${score ?? 0}\nNAME: ${name ?? ''}`;
    fs.writeFileSync(overlayPath(matchid), text, 'utf8');
    res.json({ message: 'Overlay updated!' });
});

// 3. API stop worker (chủ động kill)
app.post('/stoplive', (req, res) => {
    const { matchid } = req.body;
    if (!matchid) return res.status(400).json({ error: 'Thiếu matchid' });
    if (runningWorkers[matchid]) {
        runningWorkers[matchid].proc.kill();
        delete runningWorkers[matchid];
        res.json({ message: 'Worker stopped' });
    } else {
        res.json({ message: 'Không có worker nào chạy cho matchid này' });
    }
});

// 4. Webhook: Khi client ngắt ingest (on_done)
app.post('/hook/on_done', (req, res) => {
    const matchid = req.body.name;
    if (runningWorkers[matchid]) {
        runningWorkers[matchid].proc.kill();
        delete runningWorkers[matchid];
        console.log(`[${matchid}] FFmpeg auto-killed by on_done`);
    }
    res.end();
});

app.listen(3001, () => console.log('Livestream Controller API running at 3001'));
