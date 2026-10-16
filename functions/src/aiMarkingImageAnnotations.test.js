import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { annotateMarkedImages, renderAnnotatedImage } from './aiMarkingImageAnnotations.js';

const sampleAnnotation = (overrides = {}) => ({
  questionId: 'paper-a::1.1', questionNumber: '1.1', imageIndex: 0,
  type: 'tick', x: 0.5, y: 0.5, stepId: 'step_1', confidence: 0.96,
  ...overrides,
});

const createWhitePng = (width = 240, height = 180) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#111111';
  context.fillRect(15, 15, 20, 20);
  return canvas.toBuffer('image/png');
};

test('renders visible tick and cross overlays without changing pixels away from the target', async () => {
  const source = createWhitePng();
  const { buffer, width, height } = await renderAnnotatedImage({
    buffer: source,
    annotations: [sampleAnnotation(), sampleAnnotation({ type: 'cross', x: 0, y: 1, stepId: 'step_2' })],
  });
  assert.equal(width, 240);
  assert.equal(height, 180);
  assert.notDeepEqual(buffer, source);
  const rendered = await loadImage(buffer);
  const canvas = createCanvas(rendered.width, rendered.height);
  const context = canvas.getContext('2d');
  context.drawImage(rendered, 0, 0);
  const targetPixel = context.getImageData(120, 90, 1, 1).data;
  const untouchedPixel = context.getImageData(100, 20, 1, 1).data;
  assert.notDeepEqual([...targetPixel], [255, 255, 255, 255]);
  assert.deepEqual([...untouchedPixel], [255, 255, 255, 255]);
  const pixels = context.getImageData(0, 0, rendered.width, rendered.height).data;
  let purplePixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 170 && pixels[index + 2] > 120 && pixels[index + 2] > pixels[index]) purplePixels += 1;
  }
  assert.ok(purplePixels > 0, 'expected the AI purple tick/cross strokes and label');
  assert.deepEqual([...context.getImageData(20, 20, 1, 1).data], [17, 17, 17, 255]);
});

test('stores a separate versioned annotated copy and reuses it on retry', async () => {
  const sourceBuffer = createWhitePng();
  const objects = new Map();
  let destinationWrites = 0;
  const bucket = {
    name: 'examifying-test.appspot.com',
    file(path) {
      return {
        async download() {
          const object = objects.get(path);
          if (!object) throw new Error(`missing ${path}`);
          return [object.buffer];
        },
        async exists() { return [objects.has(path)]; },
        async getMetadata() { return [objects.get(path).metadata]; },
        async save(buffer, options) {
          destinationWrites += 1;
          objects.set(path, { buffer: Buffer.from(buffer), metadata: options.metadata });
        },
        async setMetadata(options) {
          const object = objects.get(path);
          object.metadata = { ...object.metadata, ...options, metadata: { ...object.metadata.metadata, ...options.metadata } };
        },
        async delete() { objects.delete(path); },
      };
    },
  };
  const sourcePath = 'users/student/subjects/math/exercises/exercise/submissions/page-1.png';
  objects.set(sourcePath, { buffer: sourceBuffer, metadata: {} });
  const image = { file: bucket.file(sourcePath), storagePath: sourcePath, pageNumber: 1 };
  const args = {
    images: [image], annotations: [sampleAnnotation()], markingMode: 'student_exercise', bucket,
    destinationPrefix: 'users/student/subjects/math/exercises/exercise/ai-marking-annotations',
    version: 'a'.repeat(40),
  };
  const first = await annotateMarkedImages(args);
  const second = await annotateMarkedImages(args);
  assert.equal(destinationWrites, 1);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].pageNumber, 1);
  assert.equal(first[0].storagePath, `${args.destinationPrefix}/${args.version}-image-1.png`);
  assert.equal(first[0].markingMode, 'student_exercise');
  assert.notEqual(objects.get(first[0].storagePath).buffer, sourceBuffer);
  assert.equal(objects.get(sourcePath).buffer, sourceBuffer);
});

test('uses the same annotation utility for peer-marking images and stores a distinct AI copy', async () => {
  const objects = new Map();
  const bucket = {
    name: 'examifying-test.appspot.com',
    file(path) {
      return {
        async download() { return [objects.get(path).buffer]; },
        async exists() { return [objects.has(path)]; },
        async getMetadata() { return [objects.get(path).metadata]; },
        async save(buffer, options) { objects.set(path, { buffer: Buffer.from(buffer), metadata: options.metadata }); },
        async setMetadata(options) { objects.get(path).metadata.metadata = { ...objects.get(path).metadata.metadata, ...options.metadata }; },
      };
    },
  };
  const sourcePath = 'users/reviewer/subjects/physics/exercises/review-day/peer-reviews/page-1.png';
  objects.set(sourcePath, { buffer: createWhitePng(), metadata: {} });
  const destinationPrefix = 'users/reviewer/subjects/physics/exercises/review-day/ai-marking-annotations';
  const images = await annotateMarkedImages({
    images: [{ file: bucket.file(sourcePath), storagePath: sourcePath, pageNumber: 1 }],
    annotations: [sampleAnnotation({ type: 'cross' })],
    markingMode: 'peer_marking',
    bucket,
    destinationPrefix,
    version: 'c'.repeat(40),
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].markingMode, 'peer_marking');
  assert.equal(images[0].storagePath, `${destinationPrefix}/${'c'.repeat(40)}-image-1.png`);
  assert.match(images[0].url, /token=/);
});

test('ignores annotations outside the supplied image set and produces no copies', async () => {
  const sourceBuffer = createWhitePng();
  let downloads = 0;
  const bucket = {
    name: 'examifying-test.appspot.com',
    file: () => ({
      async download() { downloads += 1; return [sourceBuffer]; },
      async exists() { return [false]; },
    }),
  };
  const result = await annotateMarkedImages({
    images: [{ file: bucket.file('unused'), storagePath: 'users/student/submissions/1.png', pageNumber: 1 }],
    annotations: [sampleAnnotation({ imageIndex: 5 })], markingMode: 'peer_marking', bucket,
    destinationPrefix: 'users/student/subjects/math/exercises/exercise/ai-marking-annotations', version: 'b'.repeat(40),
  });
  assert.deepEqual(result, []);
  assert.equal(downloads, 0);
});
