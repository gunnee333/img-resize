// 이미지 업로드 관련 클래스
class ImageUtil {
  // ==================================================
  // Public Methods
  // ==================================================

  // 이미지 파일들을 검증 / Crop / Resize / WebP 변환 후 list 형태로 반환
  static async imageToFileList({
    event = null,
    prevFiles = [],
    maxFileSizeMB = 10,
    maxWidth = null,
    limitWidth = null,
    limitHeight = null,
    maxLength = null,
    isCrop = false,
    cropRatio = null,
    quality = 1
  }) {
    try {
      const files = Array.from(event?.target.files || prevFiles || []);

      const totalCnt = files.length;
      if (totalCnt === 0) {
        alert('파일을 선택해주세요.');
        if (event) {
          event.target.value = '';
        }
        return null;
      }

      if (maxLength && totalCnt > maxLength) {
        alert(`최대 ${maxLength}개의 파일만 업로드 가능합니다.`);
        if (event) {
          event.target.value = '';
        }
        return null;
      }

      loading?.();

      const fileList = [];
      for (const [index, file] of files.entries()) {
        try {
          if (!file.type.match('image.*')) {
            alert(`${file.name}은(는) 이미지 파일이 아닙니다.`);
            continue;
          }
          if (file.size > maxFileSizeMB * 1048576) {
            alert(`${file.name}의 크기는 ${maxFileSizeMB}MB를 초과합니다.`);
            continue;
          }
          const isGif = file.type === 'image/gif';
          let processedFile = file;

          if (isCrop && !isGif) {
            loadingEnd?.();
            try {
              processedFile = await ImageUtil.cropImage(file, {
                aspectRatio: cropRatio,
                totalCnt,
                curPage: index + 1
              });
              loading?.();
            } catch (cropError) {
              console.error(`[${file.name}] Crop 실패:`, cropError);
              loading?.();
              continue;
            }
          }

          if (isGif) {
            processedFile = await ImageUtil.#optimizeGif({
              file,
              maxWidth,
              quality
            });
          } else {
            processedFile = await ImageUtil.resizeImage({
              file: processedFile,
              maxWidth,
              limitWidth,
              limitHeight,
              quality
            });
          }

          const originSize = await ImageUtil.#getImageSize(file);
          const newSize = await ImageUtil.#getImageSize(processedFile);

          fileList.push({
            originFile: { file, size: originSize },
            newFile: { file: processedFile, size: newSize }
          });

          console.log(
            `✅ [${file.name}] 원본: ${(file.size / 1024).toFixed(
              1
            )}KB → 처리 후: ${(processedFile.size / 1024).toFixed(1)}KB`
          );
        } catch (fileError) {
          console.error(`[${file.name}] 처리 실패:`, fileError);
          throw fileError;
        }
      }

      if (event) {
        event.target.value = '';
      }
      loadingEnd?.();

      return fileList;
    } catch (error) {
      console.error('imageToFormData error', error);
      if (event) {
        event.target.value = '';
      }
      loadingEnd?.();
      return null;
    }
  }

  // 이미지 사이즈를 검증하고, 필요한 경우 Resize 후 webp로 변환
  static async resizeImage({
    file,
    maxWidth = null,
    limitWidth = null,
    limitHeight = null,
    quality = 1
  }) {
    const webpQuality = quality * 0.7;
    if (!maxWidth && !limitWidth && !limitHeight) {
      // 리사이징 조건 없음: 원본파일을 webp로 변환
      return await ImageUtil.#convertToWebP({
        file,
        quality: webpQuality
      });
    }

    const URLObject = window.URL || window.webkitURL;
    const objectUrl = URLObject.createObjectURL(file);

    try {
      const img = await ImageUtil.#loadImage(objectUrl);
      const width = img.width;
      const height = img.height;

      if (
        (limitWidth && width > limitWidth) ||
        (limitHeight && height > limitHeight)
      ) {
        // width * height 제한
        const errMsg = ImageUtil.#getLimitRejectMessage({
          width,
          height,
          limitWidth,
          limitHeight
        });
        alert(errMsg);
        throw new Error(errMsg);
      }

      if (!maxWidth || width <= maxWidth) {
        // 리사이징 필요 없음
        return await ImageUtil.#convertToWebP({
          file,
          quality: webpQuality
        });
      }

      // 리사이징
      const scale = maxWidth / width;
      const targetWidth = maxWidth;
      const targetHeight = Math.round(height * scale);
      const bitmap = await createImageBitmap(file, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'high'
      });

      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas Context 생성 실패');
        }
        ctx.drawImage(bitmap, 0, 0);

        // 리사이징 webp
        const webpFile = await ImageUtil.#createWebPFile({
          canvas,
          fileName: file.name,
          quality: 1
        });

        // 원본 webp
        const originWebpFile = await ImageUtil.#convertToWebP({
          file,
          quality: webpQuality
        });

        // (원본 webp 용량 <= 리사이징 webp 용량 * 1.2) => 원본 webp 반환
        if (originWebpFile.size <= webpFile.size * 1.2) {
          return originWebpFile;
        }
        return webpFile;
      } finally {
        bitmap.close();
      }
    } finally {
      // Object URL 정리
      URLObject.revokeObjectURL(objectUrl);
    }
  }

  // 이미지 Crop 모달 생성
  static async cropImage(
    file,
    { aspectRatio = null, totalCnt = null, curPage = null } = {}
  ) {
    const pageHtml =
      curPage && totalCnt
        ? `(${[curPage, totalCnt].filter((item) => !!item).join(' / ')})`
        : '';

    const imageDataUrl = await ImageUtil.#readFileAsDataURL(file);

    const modal = document.createElement('div');
    modal.innerHTML = `
      <div class="image-crop-overlay"></div>
      <div class="image-crop-container">
        <div class="image-crop-header">
          <span>이미지 편집 ${pageHtml}</span>
        </div>
        <div class="image-crop-body">
          <img class="image-crop-image" />
        </div>
        <div class="image-crop-footer">
          <button type="button" class="btn btn-danger crop-cancel">
            업로드 취소
          </button>
          <button type="button" class="btn btn-success crop-confirm">
            업로드
          </button>
        </div>
      </div>
    `;

    modal.className = 'image-crop-modal';

    document.body.appendChild(modal);
    const image = modal.querySelector('.image-crop-image');
    image.src = imageDataUrl;

    await ImageUtil.#waitForImageLoad(image);

    const cropper = new Cropper(image, {
      aspectRatio,
      viewMode: 1,
      dragMode: 'move',
      autoCropArea: 1,
      responsive: true,
      background: false,
      movable: true,
      zoomable: true,
      rotatable: false,
      scalable: false
    });

    try {
      const croppedCanvas = await ImageUtil.#waitForCrop(modal, cropper);

      const blob = await ImageUtil.#canvasToBlob(
        croppedCanvas,
        file.type || 'image/jpeg',
        1
      );

      return new File([blob], file.name, {
        type: file.type || 'image/jpeg',
        lastModified: Date.now()
      });
    } finally {
      cropper.destroy();
      modal.remove();
    }
  }

  // url -> file 객체 변환
  static async convertUrlToFile(imgUrl) {
    try {
      const response = await fetch(imgUrl, {
        method: 'GET',
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error(`이미지 요청 실패 (${response.status})`);
      }
      const blob = await response.blob();
      if (
        !blob.type ||
        !blob.type.startsWith('image/') ||
        blob.type.toLowerCase() === 'image/gif'
      ) {
        alert(
          `이미지 파일만 수정 가능합니다. (${blob.type || '알 수 없는 형식'})`
        );
        return null;
      }

      return new File([blob], 'image.jpg', {
        type: blob.type || 'image/jpeg'
      });
    } catch (error) {
      console.error('convertUrlToFile error', error);
      alert(`이미지 로드 오류. 다시 시도해주세요.`);
      throw error;
    }
  }

  // ==================================================
  // Private Static Methods
  // ==================================================

  // file => webp file 변환
  static async #convertToWebP({ file, quality = 1 }) {
    const URLObject = window.URL || window.webkitURL;
    const objectUrl = URLObject.createObjectURL(file);

    try {
      const img = await ImageUtil.#loadImage(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas Context 생성 실패');
      }

      ctx.drawImage(img, 0, 0);
      return await ImageUtil.#createWebPFile({
        canvas,
        fileName: file.name,
        quality
      });
    } finally {
      URLObject.revokeObjectURL(objectUrl);
    }
  }

  // canvas -> webp file 변환
  static async #createWebPFile({ canvas, fileName, quality }) {
    const blob = await ImageUtil.#canvasToBlob(canvas, 'image/webp', quality);
    const webpFileName = fileName.replace(/\.[^/.]+$/, '.webp');
    return new File([blob], webpFileName, {
      type: 'image/webp'
    });
  }

  // canvas -> blob 변환
  static async #canvasToBlob(canvas, type, quality) {
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('이미지 Blob 변환 실패'));
            return;
          }
          resolve(blob);
        },
        type,
        quality
      );
    });
  }

  // 이미지 url -> image 객체 반환
  static async #loadImage(src) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('이미지 로딩 실패'));
      img.src = src;
    });
  }

  // file -> data url
  static async #readFileAsDataURL(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        resolve(reader.result);
      };

      reader.onerror = () => {
        reject(new Error('이미지를 읽을 수 없습니다.'));
      };

      reader.readAsDataURL(file);
    });
  }

  // cropper 사용자 입력 대기
  static async #waitForCrop(modal, cropper) {
    return await new Promise((resolve, reject) => {
      // 업로드 취소 버튼
      modal.querySelector('.crop-cancel').addEventListener('click', () => {
        reject(new Error('사용자가 취소했습니다.'));
      });

      // 업로드 확인 버튼
      modal.querySelector('.crop-confirm').addEventListener('click', () => {
        if (!cropper) {
          reject(new Error('Cropper가 생성되지 않았습니다.'));
          return;
        }

        const canvas = cropper.getCroppedCanvas({
          imageSmoothingEnabled: true,
          imageSmoothingQuality: 'high'
        });

        if (!canvas) {
          reject(new Error('이미지 Crop에 실패했습니다.'));
          return;
        }

        resolve(canvas);
      });
    });
  }

  // imgae 객체 load 대기
  static async #waitForImageLoad(image) {
    if (image.complete) {
      if (image.naturalWidth > 0) {
        return image;
      }
    }
    return await new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('이미지 로딩 실패'));
    });
  }

  // 이미지 크기 제한 오류 메시지
  static #getLimitRejectMessage({ width, height, limitWidth, limitHeight }) {
    let message = '적합하지 않은 이미지 사이즈 입니다.';
    if (limitWidth && limitHeight) {
      message += ` ${limitWidth} x ${limitHeight}`;
    } else if (limitWidth && !limitHeight) {
      message += ` 너비 ${limitWidth}`;
    } else if (!limitWidth && limitHeight) {
      message += ` 높이 ${limitHeight}`;
    }
    message += ` 이하 사이즈의 이미지를 업로드 해주세요. (현재이미지 ${width} x ${height})`;
    return message;
  }

  // gif 리사이징
  static async #optimizeGif({
    file,
    maxWidth = null,
    quality = 10,
    minSavingsRatio = 0.1
  }) {
    if (!(file instanceof File)) {
      throw new Error('GIF File이 아닙니다.');
    }
    if (!/^image\/gif$/i.test(file.type)) {
      throw new Error('GIF 파일이 아닙니다.');
    }

    if (!maxWidth) {
      return file;
    }

    if (typeof SuperGif !== 'function') {
      throw new Error('SuperGif가 로드되지 않았습니다.');
    }
    if (typeof GIF !== 'function') {
      throw new Error('gif.js가 로드되지 않았습니다.');
    }

    const URLObject = window.URL || window.webkitURL;
    const objectUrl = URLObject.createObjectURL(file);

    let image = null;
    let superGif = null;

    try {
      image = document.createElement('img');
      image.style.display = 'none';
      document.body.appendChild(image);
      image.src = objectUrl;
      await ImageUtil.#waitForImageLoad(image);

      superGif = new SuperGif({
        gif: image,
        auto_play: false
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        try {
          superGif.load(() => done());
        } catch (error) {
          done(error);
        }
      });

      const sourceCanvas = superGif.get_canvas();
      if (!sourceCanvas) {
        throw new Error('GIF Canvas 생성 실패');
      }

      const sourceWidth = sourceCanvas.width;
      const sourceHeight = sourceCanvas.height;
      const frameCount = superGif.get_length();
      if (!frameCount || frameCount <= 0) {
        throw new Error('GIF Frame을 찾을 수 없습니다.');
      }

      if (sourceWidth <= maxWidth) {
        return file;
      }

      const scale = maxWidth / sourceWidth;
      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
      const encoder = new GIF({
        workers: 2,
        quality: Math.max(1, Math.min(30, quality)), // 숫자가 낮을수록 색상 샘플링 품질 좋음 / 기본값 10
        width: targetWidth,
        height: targetHeight,
        repeat: 0, // GIF는 일반적으로 반복 재생
        workerScript: '/admin/public/js/gif.worker.js'
      });

      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = targetWidth;
      frameCanvas.height = targetHeight;
      const frameCtx = frameCanvas.getContext('2d');
      if (!frameCtx) {
        throw new Error('GIF Frame Canvas Context 생성 실패');
      }

      frameCtx.imageSmoothingEnabled = true;
      frameCtx.imageSmoothingQuality = 'high';

      // 프레임별 작업
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        superGif.move_to(frameIndex);
        const currentCanvas = superGif.get_canvas();
        if (!currentCanvas) {
          throw new Error(`GIF Frame ${frameIndex} Canvas 생성 실패`);
        }

        // 이전 Frame의 픽셀이 남지 않도록 초기화.
        frameCtx.clearRect(0, 0, targetWidth, targetHeight);

        // 고품질 resize.
        frameCtx.drawImage(
          currentCanvas,
          0,
          0,
          sourceWidth,
          sourceHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );

        let delay = 100;

        if (typeof superGif.get_frames === 'function') {
          const frames = superGif.get_frames();

          if (frames?.[frameIndex]?.delay != null) {
            delay = Math.max(20, Number(frames[frameIndex].delay) * 10);
          }
        }

        encoder.addFrame(frameCanvas, {
          copy: true,
          delay
        });
      }

      const optimizedBlob = await new Promise((resolve, reject) => {
        encoder.on('finished', (blob) => resolve(blob));
        encoder.on('abort', () =>
          reject(new Error('GIF encoding이 중단되었습니다.'))
        );
        try {
          encoder.render();
        } catch (error) {
          reject(error);
        }
      });

      if (!optimizedBlob) {
        throw new Error('최적화 GIF 생성 실패');
      }

      const originalSize = file.size;
      const optimizedSize = optimizedBlob.size;

      console.log(
        `[GIF] 원본: ${(originalSize / 1024).toFixed(1)}KB / 최적화: ${(
          optimizedSize / 1024
        ).toFixed(1)}KB`
      );

      const minOptimizedSize = originalSize * (1 - minSavingsRatio);

      // 최적화 결과가 충분히 작아진 경우만 사용.
      if (optimizedSize < minOptimizedSize) {
        const optimizedFileName = file.name.replace(/\.gif$/i, '.gif');

        const optimizedFile = new File([optimizedBlob], optimizedFileName, {
          type: 'image/gif',
          lastModified: Date.now()
        });

        const savingPercent = (1 - optimizedSize / originalSize) * 100;

        console.log(`[GIF] 최적화 적용: ${savingPercent.toFixed(1)}% 감소`);

        return optimizedFile;
      }

      // 원본사용
      return file;
    } catch (error) {
      console.error('[GIF] optimizeGif error:', error);
      return file;
    } finally {
      if (superGif) {
        try {
          superGif.pause?.();
        } catch (e) {
          console.warn('[GIF] SuperGif 정리 실패:', e);
        }
      }
      if (image) {
        image.remove();
      }
      URLObject.revokeObjectURL(objectUrl);
    }
  }

  // File 객체에서 이미지의 실제 width, height 반환
  static async #getImageSize(file) {
    const URLObject = window.URL || window.webkitURL;
    const objectUrl = URLObject.createObjectURL(file);

    try {
      const img = await ImageUtil.#loadImage(objectUrl);

      return {
        width: img.naturalWidth,
        height: img.naturalHeight
      };
    } finally {
      URLObject.revokeObjectURL(objectUrl);
    }
  }
}
