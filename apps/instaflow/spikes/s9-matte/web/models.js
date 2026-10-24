// Model registry ("model cards" for the spike). Files live in ../models/ (gitignored; `npm run setup`).
// commercial: true only when BOTH code and weights carry a licence permitting commercial use (see README §Licensing).
const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
const HALF = { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] };

export const MODELS = {
  birefnet_lite:      { file: 'birefnet_lite_fp32.onnx', inW: 1024, inH: 1024, ...IMAGENET, sigmoid: true, licence: 'MIT', commercial: true, note: 'BiRefNet general, Swin-T backbone (official GitHub release v1)' },
  birefnet_lite_fp16: { file: 'birefnet_lite_fp16.onnx', inW: 1024, inH: 1024, ...IMAGENET, sigmoid: true, licence: 'MIT', commercial: true, note: 'local fp16 conversion (fp32 I/O)' },
  birefnet_lite_int8: { file: 'birefnet_lite_int8.onnx', inW: 1024, inH: 1024, ...IMAGENET, sigmoid: true, licence: 'MIT', commercial: true, note: 'local dynamic int8 (MatMul only)' },
  birefnet_portrait_fp16: { file: 'birefnet_portrait_fp16.onnx', inW: 1024, inH: 1024, ...IMAGENET, sigmoid: true, licence: 'MIT', commercial: true, note: 'BiRefNet portrait, Swin-L backbone, local fp16 conversion' },
  modnet_int8:        { file: 'modnet_int8.onnx', inW: 896, inH: 512, ...HALF, licence: 'Apache-2.0', commercial: true, note: 'Xenova/modnet int8 via unofficial npm re-host; provenance unverified' },
  modnet_int8_288:    { file: 'modnet_int8.onnx', inW: 512, inH: 288, ...HALF, licence: 'Apache-2.0', commercial: true, note: 'same weights, 512x288 input' },
  u2netp:             { file: 'u2netp.onnx', inW: 320, inH: 320, ...IMAGENET, minmax: true, outName: '1959', licence: 'Apache-2.0', commercial: true, note: 'U²-Net-p (4.6 MB), rembg mirror' },
  u2netp_fp16:        { file: 'u2netp_fp16.onnx', inW: 320, inH: 320, ...IMAGENET, minmax: true, outName: '1959', licence: 'Apache-2.0', commercial: true, note: 'local fp16 conversion' },
  u2net_human_seg:    { file: 'u2net_human_seg.onnx', inW: 320, inH: 320, ...IMAGENET, minmax: true, outName: '1959', licence: 'Apache-2.0 (code); weights: no explicit licence statement', commercial: null, note: 'rembg mirror; weights from U-2-Net repo' },
  mediapipe_selfie:   { file: 'selfie_segmenter_f16.tflite', mediapipe: true, licence: 'Apache-2.0', commercial: true, note: 'fallback tier: MediaPipe tasks-vision 1.1.1, 256x256' },
};

export const PRESETS = {
  // cloud container (SwiftShader, 4 noisy cores): small frame counts, big models only a few frames
  cloud: { runs: [
    ['mediapipe_selfie', 'webgpu', 24], ['mediapipe_selfie', 'wasm', 24],
    ['u2netp', 'webgpu', 12], ['u2netp', 'wasm', 12],
    ['modnet_int8_288', 'webgpu', 12], ['modnet_int8_288', 'wasm', 12],
    ['modnet_int8', 'wasm', 6],
    ['birefnet_lite', 'webgpu', 3], ['birefnet_lite', 'wasm', 3],
  ] },
  // owner's Mac (Metal GPU, Chrome): enough frames for stable fps + flicker
  owner: { runs: [
    ['mediapipe_selfie', 'webgpu', 60], ['mediapipe_selfie', 'wasm', 60],
    ['birefnet_lite', 'webgpu', 30], ['birefnet_lite_fp16', 'webgpu', 30], ['birefnet_lite', 'wasm', 4], ['birefnet_lite_int8', 'wasm', 4],
    ['birefnet_portrait_fp16', 'webgpu', 12],
    ['modnet_int8', 'webgpu', 60], ['modnet_int8_288', 'webgpu', 60], ['modnet_int8', 'wasm', 20],
    ['u2netp', 'webgpu', 60], ['u2netp_fp16', 'webgpu', 60], ['u2netp', 'wasm', 30],
  ] },
};
