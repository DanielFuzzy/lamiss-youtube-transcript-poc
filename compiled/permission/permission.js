"use strict";
// Chrome can't show the microphone prompt from an extension popup, so the
// popup opens this tab instead. Permission is granted per extension origin,
// so once it's allowed here the popup can record too.
const micStatus = document.getElementById('micStatus');
const grantMicButton = document.getElementById('grantMic');
function setMicStatus(message, state) {
    if (micStatus) {
        micStatus.textContent = message;
        micStatus.className = state;
    }
}
async function requestMicrophoneAccess() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        setMicStatus('Microphone enabled. Close this tab and ask Lamiss from the extension popup.', 'granted');
        if (grantMicButton) {
            grantMicButton.hidden = true;
        }
    }
    catch (error) {
        console.error('Lamiss POC: microphone permission error:', error);
        setMicStatus('Microphone access was blocked. Click the icon at the right of the address bar to allow it, then try again.', 'denied');
    }
}
grantMicButton?.addEventListener('click', () => {
    void requestMicrophoneAccess();
});
void requestMicrophoneAccess();
