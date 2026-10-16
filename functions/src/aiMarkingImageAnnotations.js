import { randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const isValidAnnotation = (annotation) => annotation
  && Number.isSafeInteger(annotation.imageIndex) && annotation.imageIndex >= 0
  && ['tick', 'cross'].includes(annotation.type)
  && Number.isFinite(annotation.x) && annotation.x >= 0 && annotation.x <= 1
  && Number.isFinite(annotation.y) && annotation.y >= 0 && annotation.y <= 1
  && typeof annotation.questionId === 'string' && annotation.questionId
  && typeof annotation.questionNumber === 'string' && annotation.questionNumber
  && Number.isFinite(annotation.confidence) && annotation.confidence >= 0 && annotation.confidence <= 1
  && typeof annotation.stepId === 'string' && annotation.stepId;

const urlForStoredImage = (bucket, path, token) => `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(path)}?alt=media&token=${encodeURIComponent(token)}`;

const drawSymbol = (context, annotation, width, height) => {
  const radius = clamp(Math.round(Math.min(width, height) * 0.051), 16, 48);
  const x = clamp(annotation.x * width, radius + 3, width - radius - 3);
  const y = clamp(annotation.y * height, radius + 3, height - radius - 3);
  const strokeWidth = clamp(radius * 0.28, 4, 11);
  const paths = annotation.type === 'tick'
    ? [[[-0.58, 0.02], [-0.16, 0.43], [0.61, -0.51]]]
    : [
      [[-0.48, -0.48], [0.48, 0.48]],
      [[0.48, -0.48], [-0.48, 0.48]],
    ];

  for (const points of paths) {
    context.beginPath();
    points.forEach(([dx, dy], index) => {
      const pointX = x + dx * radius;
      const pointY = y + dy * radius;
      if (index === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    });
    context.strokeStyle = '#ffffff';
    context.lineWidth = strokeWidth + 6;
    context.stroke();
    context.strokeStyle = '#dc2626';
    context.lineWidth = strokeWidth;
    context.stroke();
  }

  const label = 'AI';
  const fontSize = clamp(Math.round(radius * 0.62), 10, 20);
  context.font = `800 ${fontSize}px sans-serif`;
  const labelWidth = context.measureText(label).width + 9;
  const labelHeight = fontSize + 5;
  const labelX = clamp(x + radius * 0.48, 2, width - labelWidth - 2);
  const labelY = clamp(y - radius * 0.92, labelHeight + 2, height - 2);
  context.fillStyle = '#dc2626';
  context.beginPath();
  context.roundRect(labelX, labelY - labelHeight, labelWidth, labelHeight, 3);
  context.fill();
  context.fillStyle = '#ffffff';
  context.textBaseline = 'middle';
  context.fillText(label, labelX + 3.5, labelY - labelHeight / 2);
};

export const renderAnnotatedImage = async ({ buffer, annotations = [] }) => {
  const image = await loadImage(buffer);
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('The submitted image has invalid dimensions.');
  }
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  annotations.filter(isValidAnnotation).forEach((annotation) => drawSymbol(context, annotation, width, height));
  return { buffer: canvas.toBuffer('image/png'), width, height };
};

export const annotateMarkedImages = async ({
  images = [],
  annotations = [],
  markingMode,
  bucket,
  destinationPrefix,
  version,
}) => {
  if (!['student_exercise', 'peer_marking'].includes(markingMode)) throw new Error('The AI image annotation mode is invalid.');
  if (!bucket || !destinationPrefix || !version) throw new Error('AI image annotation storage details are incomplete.');
  const normalizedPrefix = String(destinationPrefix).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPrefix.startsWith('users/') || normalizedPrefix.split('/').some((part) => part === '..' || !part)) {
    throw new Error('The AI image annotation destination failed path validation.');
  }
  const safeVersion = String(version);
  if (!/^[a-f0-9]{16,64}$/i.test(safeVersion)) throw new Error('The AI image annotation version is invalid.');
  const annotationsByImage = new Map();
  for (const annotation of annotations.filter(isValidAnnotation)) {
    if (annotation.imageIndex >= images.length) continue;
    const rows = annotationsByImage.get(annotation.imageIndex) ?? [];
    rows.push(annotation);
    annotationsByImage.set(annotation.imageIndex, rows);
  }

  const output = [];
  for (const [imageIndex, image] of images.entries()) {
    const imageAnnotations = annotationsByImage.get(imageIndex) ?? [];
    if (!imageAnnotations.length) continue;
    if (!image?.file || !String(image.storagePath ?? '').startsWith('users/')) {
      throw new Error('An AI annotation source image is missing its validated Storage reference.');
    }
    const destinationPath = `${normalizedPrefix}/${safeVersion}-r2-image-${imageIndex + 1}.png`;
    const destination = bucket.file(destinationPath);
    const [exists] = await destination.exists();
    let token = '';
    let width = 0;
    let height = 0;
    if (exists) {
      const [metadata] = await destination.getMetadata();
      token = String(metadata.metadata?.firebaseStorageDownloadTokens ?? '').split(',')[0];
      width = Number(metadata.metadata?.aiAnnotationWidth) || 0;
      height = Number(metadata.metadata?.aiAnnotationHeight) || 0;
    } else {
      const [sourceBuffer] = await image.file.download();
      const rendered = await renderAnnotatedImage({ buffer: sourceBuffer, annotations: imageAnnotations });
      token = randomUUID();
      width = rendered.width;
      height = rendered.height;
      await destination.save(rendered.buffer, {
        resumable: false,
        metadata: {
          contentType: 'image/png',
          cacheControl: 'private,max-age=3600',
          metadata: {
            firebaseStorageDownloadTokens: token,
            aiMarkingVersion: safeVersion,
            aiMarkingMode: markingMode,
            aiAnnotationSourcePath: image.storagePath,
            aiAnnotationSourceImageIndex: String(imageIndex),
            aiAnnotationCount: String(imageAnnotations.length),
            aiAnnotationWidth: String(width),
            aiAnnotationHeight: String(height),
          },
        },
      });
    }
    if (!token) {
      token = randomUUID();
      await destination.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
    output.push({
      imageIndex,
      pageNumber: Number(image.pageNumber) || imageIndex + 1,
      url: urlForStoredImage(bucket, destinationPath, token),
      storagePath: destinationPath,
      width,
      height,
      annotationCount: imageAnnotations.length,
      markingMode,
      version: safeVersion,
    });
  }
  return output;
};
