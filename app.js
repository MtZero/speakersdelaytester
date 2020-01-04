window.addEventListener('click', init);
document.addEventListener('touchstart', init);
var cnt = 0;
var stdTime = (new Date()).getTime();

function init() {
    window.removeEventListener("click", init);
    document.removeEventListener("touchstart", init);
    document.getElementById("tts").hidden = true;
    document.getElementById("delay").hidden = false;
    setInterval(run, 800);
    stdTime = (new Date()).getTime();
    window.addEventListener("click", touch);
    document.addEventListener("touchstart", touch);
}

function run() {
    stdTime = (new Date()).getTime() + 400;
    if (cnt === 0) beep(0.39, 0.02, 1000);
    else beep(0.39, 0.02, 800);
    cnt = (cnt + 1) % 4;
}

function touch() {
    var touchTime = (new Date()).getTime();
    document.getElementById("delay").innerText = (touchTime - stdTime) + "ms";
}

function beep(start, duration, freq) {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    var audioCtx = new AudioContext();

    // create Oscillator and gain node
    var oscillator = audioCtx.createOscillator();
    var gainNode = audioCtx.createGain();

    // connect oscillator to gain node to speakers

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.detune.value = 100; // value in cents
    oscillator.start(start);
    oscillator.stop(start+duration);

    oscillator.frequency.value = freq;
    gainNode.gain.value = 0.5;
}
