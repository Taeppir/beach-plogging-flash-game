# 🏖️ 30초 해변 플로깅 게임
> 해양환경공단 2026 AI·데이터 서포터즈 팀 미션 산출물

국가해안쓰레기모니터링통계(MEIS) 데이터로 만든 30초 미니게임  
게임 속에서 해안 쓰레기를 주우며 실제 해양 데이터를 소개하고, 데이터 활성화 성과를 정량 측정

## 구조

```
public/          ← 게임 (Cloudflare Pages로 배포)
  index.html       메인 게임
  stats.html       발표용 지표 대시보드
api/             ← API (Cloudflare Workers로 배포)
  worker.js        랭킹 + 이벤트 수집 + 통계 집계
wrangler.toml    ← Worker 배포 설정 (D1 바인딩)
schema.sql       ← D1 테이블 스키마
```

## 데이터 출처
https://www.meis.go.kr/mli/monitoringInfo/stat.do  
국가해안쓰레기모니터링통계 (해양환경정보포털 MEIS), 2018~2023, 전국 60개 조사지점.
게임 내 쓰레기 등장 확률·점수는 유형별 실측 개수(총 480,052개)를 그대로 반영.
