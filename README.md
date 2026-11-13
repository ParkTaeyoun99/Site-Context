# Site Context

대지 지번을 넣으면 주변 필지·건물을 3D로 세우고, 대지와 주변의 **높이 관계**와 **시선(내려다봄) 관계**를 분석하는 도구. 건축 설계 자동화 파이프라인의 1단계.

**사용:** https://parktaeyoun99.github.io/Site-Context/

## 기능
- V-World 연속지적도(LP_PA_CBND_BUBUN) + 도로명주소 건물(LT_C_SPBD) → 3D 맥락 모델
- 높이 관계: 대지 지반 기준 주변 건물 높이 색상
- 시선 분석: 주변 건물 옥상에서 대지가 보이는 비율
- 단면선: 두 점을 찍어 지반·건물 단면 (1:1 축척)
- 내보내기: DXF(SITE / PARCEL / BLDG / BLDG_ROOF, 단위 m), 프로젝트 JSON, PNG

## 설정
V-World 인증키(2D데이터·검색 API)를 화면에 입력. 등록 도메인 = 이 페이지 주소.

## 개발
`src/app.js`, `src/template.html` 수정 → `npm install && npm run build` → `index.html` 생성.

## 다음 단계
2. 법규 볼륨 (용도지역, 건폐율·용적률, 일조사선) · 3. 규칙 기반 평면 대안 생성 · 4. 3D · CAD/IFC 산출
