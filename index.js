const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const app = express();

app.use(express.json());
const runningWorkers = {}; // matchid => process

function overlayPath(matchid) {
    return `/tmp/overlay_${matchid}.txt`;
}

// 1. API khởi động live (có thể truyền url + streamkey động)
app.post('/startlive', (req, res) => {
    const { matchid, score = 0, name = '', url, streamkey } = req.body;
    if (!matchid || !url || !streamkey) return res.status(400).json({ error: 'Thiếu tham số!' });

    // Ghi overlay mặc định (hoặc từ body)
    fs.writeFileSync(overlayPath(matchid), `SCORE: ${score}\nNAME: ${name}`, 'utf8');
    if (runningWorkers[matchid]) return res.json({ message: 'Worker đã chạy!' });

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

    runningWorkers[matchid] = ffmpeg;
    res.json({ message: 'Đã start live!', ffmpegArgs });
});

// 2. API cập nhật overlay bất cứ lúc nào
app.post('/updateoverlay', (req, res) => {
    const { matchid, score, name } = req.body;
    if (!matchid) return res.status(400).json({ error: 'Thiếu matchid' });
    const text = `SCORE: ${score ?? ''}\nNAME: ${name ?? ''}`;
    fs.writeFileSync(overlayPath(matchid), text, 'utf8');
    res.json({ message: 'Overlay updated!' });
});

// 3. API stop live, kill worker ffmpeg
app.post('/stoplive', (req, res) => {
    const { matchid } = req.body;
    if (!matchid) return res.status(400).json({ error: 'Thiếu matchid' });
    if (runningWorkers[matchid]) {
        runningWorkers[matchid].kill();
        delete runningWorkers[matchid];
        res.json({ message: 'Worker stopped' });
    } else {
        res.json({ message: 'Không có worker nào chạy cho matchid này' });
    }
});

// 4. API check status (optional)
app.get('/status/:matchid', (req, res) => {
    const { matchid } = req.params;
    res.json({ running: !!runningWorkers[matchid] });
});

app.listen(3001, () => console.log('Livestream Controller API running at 3001'));
