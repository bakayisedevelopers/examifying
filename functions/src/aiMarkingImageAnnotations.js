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

const sampleInkRatio = (context, centerX, centerY, radius, width, height) => {
  const sampleRadius = Math.max(6, Math.round(radius * 0.58));
  const left = Math.max(0, Math.floor(centerX - sampleRadius));
  const top = Math.max(0, Math.floor(centerY - sampleRadius));
  const right = Math.min(width, Math.ceil(centerX + sampleRadius));
  const bottom = Math.min(height, Math.ceil(centerY + sampleRadius));
  const pixels = context.getImageData(left, top, Math.max(1, right - left), Math.max(1, bottom - top)).data;
  let ink = 0;
  let sampled = 0;
  for (let index = 0; index < pixels.length; index += 4 * 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    if (Math.min(red, green, blue) < 190 || Math.max(red, green, blue) - Math.min(red, green, blue) > 55) ink += 1;
    sampled += 1;
  }
  return sampled ? ink / sampled : 1;
};

const peerMarkPosition = (context, anchorX, y, radius, width, height) => {
  const offset = radius + 9;
  const minimumX = radius + 3;
  const maximumX = width - radius - 3;
  const candidates = [
    clamp(anchorX - offset, minimumX, maximumX),
    clamp(anchorX + offset, minimumX, maximumX),
  ].filter((candidate, index, rows) => rows.indexOf(candidate) === index);
  if (candidates.length === 1) return candidates[0];
  const scored = candidates.map((candidate) => ({
    x: candidate,
    ink: sampleInkRatio(context, candidate, y, radius, width, height),
  })).sort((a, b) => a.ink - b.ink);
  if (Math.abs(scored[0].ink - scored[1].ink) < 0.002) {
    return anchorX <= width / 2 ? scored.find((item) => item.x > anchorX)?.x ?? scored[0].x : scored.find((item) => item.x < anchorX)?.x ?? scored[0].x;
  }
  return scored[0].x;
};

const drawSymbol = (context, annotation, width, height, markingMode) => {
  const radius = clamp(Math.round(Math.min(width, height) * 0.051), 16, 48);
  const anchorX = clamp(annotation.x * width, radius + 3, width - radius - 3);
  const y = clamp(annotation.y * height, radius + 3, height - radius - 3);
  const x = markingMode === 'peer_marking'
    ? peerMarkPosition(context, anchorX, y, radius, width, height)
    : anchorX;
  const strokeWidth = clamp(radius * 0.2, 3, 8);
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
    context.lineWidth = strokeWidth + 3.5;
    context.stroke();
    context.strokeStyle = '#f87171';
    context.globalAlpha = 0.9;
    context.lineWidth = strokeWidth;
    context.stroke();
    context.globalAlpha = 1;
  }
};

export const renderAnnotatedImage = async ({ buffer, annotations = [], markingMode = 'student_exercise' }) => {
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
  annotations.filter(isValidAnnotation).forEach((annotation) => drawSymbol(context, annotation, width, height, markingMode));
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
    if (markingMode === 'peer_marking') {
      const [metadata] = await image.file.getMetadata();
      const customMetadata = metadata.metadata ?? {};
      const existingVersion = String(customMetadata.aiAnnotationVersion ?? '');
      if (existingVersion && existingVersion !== safeVersion) {
        throw new Error('This peer-marking image already contains annotations from a different AI marking version.');
      }
      const existingTokens = String(customMetadata.firebaseStorageDownloadTokens ?? '').split(',').filter(Boolean);
      const token = String(customMetadata.aiAnnotationDownloadToken ?? '')
        || (() => {
          try { return new URL(image.url).searchParams.get('token') || ''; } catch { return ''; }
        })()
        || existingTokens[0]
        || randomUUID();
      let width = Number(customMetadata.aiAnnotationWidth) || 0;
      let height = Number(customMetadata.aiAnnotationHeight) || 0;
      if (!existingVersion) {
        const [sourceBuffer] = await image.file.download();
        const rendered = await renderAnnotatedImage({ buffer: sourceBuffer, annotations: imageAnnotations, markingMode });
        width = rendered.width;
        height = rendered.height;
        const refreshedToken = randomUUID();
        await image.file.save(rendered.buffer, {
          resumable: false,
          metadata: {
            contentType: 'image/png',
            cacheControl: 'private,max-age=60',
            ...(metadata.contentDisposition ? { contentDisposition: metadata.contentDisposition } : {}),
            metadata: {
              ...customMetadata,
              firebaseStorageDownloadTokens: [...new Set([...existingTokens, token, refreshedToken])].join(','),
              aiAnnotationDownloadToken: refreshedToken,
              aiAnnotationVersion: safeVersion,
              aiAnnotationMode: markingMode,
              aiAnnotationCount: String(imageAnnotations.length),
              aiAnnotationWidth: String(width),
              aiAnnotationHeight: String(height),
            },
          },
        });
        output.push({
          imageIndex,
          pageNumber: Number(image.pageNumber) || imageIndex + 1,
          url: urlForStoredImage(bucket, image.storagePath, refreshedToken),
          storagePath: image.storagePath,
          width,
          height,
          annotationCount: imageAnnotations.length,
          markingMode,
          version: safeVersion,
        });
        continue;
      }
      output.push({
        imageIndex,
        pageNumber: Number(image.pageNumber) || imageIndex + 1,
        url: urlForStoredImage(bucket, image.storagePath, token),
        storagePath: image.storagePath,
        width,
        height,
        annotationCount: imageAnnotations.length,
        markingMode,
        version: safeVersion,
      });
      continue;
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
      const rendered = await renderAnnotatedImage({ buffer: sourceBuffer, annotations: imageAnnotations, markingMode });
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
