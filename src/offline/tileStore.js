import { Directory, Filesystem } from '@capacitor/filesystem';

export const tilePath = (layer, z, x, y) => `tiles/${layer}/${z}/${x}/${y}.png`;

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

export const writeTile = async (layer, z, x, y, blob) => {
  const data = await blobToBase64(blob);
  await Filesystem.writeFile({
    path: tilePath(layer, z, x, y),
    data,
    directory: Directory.Data,
    recursive: true,
  });
};

export const readTile = async (layer, z, x, y) => {
  try {
    const result = await Filesystem.readFile({
      path: tilePath(layer, z, x, y),
      directory: Directory.Data,
    });
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
};

export const removeTiles = async (layer, tiles) => {
  await Promise.all(
    tiles.map(({ z, x, y }) =>
      Filesystem.deleteFile({
        path: tilePath(layer, z, x, y),
        directory: Directory.Data,
      }).catch(() => {}),
    ),
  );
};
