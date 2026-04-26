'use strict';

export interface OkxCollateralItem {
  amt: string;
  ccy: string;
}

export interface OkxLoanItem {
  amt: string;
  ccy: string;
}

export interface OkxRiskWarning {
  instId: string;
  liqPx:  string;
}

export interface OkxLoan {
  ordId:                 string;
  collateralData:        OkxCollateralItem[];
  collateralNotionalUsd: string;
  curLTV:                string;
  liqLTV:                string;
  marginCallLTV:         string;
  loanData:              OkxLoanItem[];
  loanNotionalUsd:       string;
  riskWarningData?:      OkxRiskWarning;
}

export interface OkxResponse {
  ok:   boolean;
  data: unknown;
  msg:  string;
}
