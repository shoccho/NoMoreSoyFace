// Expose face-api's bundled tf instance as window.tf so coco-ssd can use it.
if (typeof faceapi !== 'undefined' && faceapi.tf) {
  window.tf = faceapi.tf;
}
