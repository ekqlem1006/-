# 플래너 위젯 (안드로이드)

웹 플래너(`/planner`)와 같은 Firestore 데이터(`users/{uid}/todos`)를 홈 화면 위젯으로 보여 주는 앱입니다.
위젯에서 할 일을 누르면 체크되고, `＋`로 오늘 할 일을 추가하며, `⟳`로 바로 새로 고칩니다.
다른 기기에서 바꾼 내용은 15분 안에(안드로이드의 최소 백그라운드 주기) 자동 반영됩니다.

## 처음 한 번 해야 하는 설정

1. [Firebase 콘솔](https://console.firebase.google.com) → 웹 플래너가 쓰는 프로젝트 → 프로젝트 설정 → **앱 추가 → Android**
   - 패키지 이름: `io.github.ekqlem1006.planner`
   - 디버그 서명 인증서 SHA-1: APK 를 서명할 키의 SHA-1 (아래 "서명 키" 참고)
2. 내려받은 **`google-services.json`** 을 `android/app/` 폴더에 넣습니다.
3. Authentication → 로그인 방법에서 Google 이 켜져 있는지 확인합니다 (웹에서 이미 쓰고 있으면 켜져 있습니다).

## 서명 키

구글 로그인은 Firebase 에 등록한 SHA-1 과 **같은 키로 서명한 APK** 에서만 됩니다.
키 파일(`*.jks`)과 `keystore.properties` 는 저장소에 올리지 않습니다 (`.gitignore`).

`android/keystore.properties`:

```properties
storeFile=planner-widget.jks
storePassword=...
keyAlias=planner
keyPassword=...
```

SHA-1 확인:

```bash
keytool -list -v -keystore planner-widget.jks -alias planner
```

## 빌드

```bash
./gradlew assembleRelease
```

결과물: `app/build/outputs/apk/release/app-release.apk`
