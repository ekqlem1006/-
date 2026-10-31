# HWP 뷰어

갤럭시(안드로이드)용 .hwp / .hwpx 뷰어. 파일은 기기 안에서만 처리합니다.

- `.hwp`: hwp.js 로 페이지 모양 그대로 표시
- `.hwpx`: ZIP/XML 을 읽어 문단·표 표시
- 텍스트 편집 후 TXT / DOCX 로 저장 (원본 파일은 덮어쓰지 않음)

## 개발
```
npm install
npm run dev
```

## APK
GitHub Actions(`.github/workflows/hwp-apk.yml`)가 `hwp-viewer/` 변경 시 디버그 APK를 만들어
Actions 실행 결과의 `hwp-viewer-apk` 아티팩트로 올립니다. 폰에 받아 설치하세요(출처 불명 앱 허용 필요).
