
;; title: fast-pool-wrapper
;; version: 1.0.0
;; summary: wrapper around fast pool contract
(define-constant deployer tx-sender)
(define-map whitelist principal bool)

(as-contract (contract-call? 'SP000000000000000000002Q6VF78.pox-3 allow-contract-caller 'SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP.pox-fast-pool-v2 none))

(define-public (delegate-stx (amount uint))
    (begin
        (asserts! (default-to false (map-get? whitelist tx-sender)) (err u401))
        (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
        (as-contract (contract-call? 'SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP.pox-fast-pool-v2 delegate-stx amount))))

(define-public (set-whitelisted (user principal) (enabled bool))
    (begin
        (asserts! (is-eq tx-sender deployer) (err u401))
        (ok (map-set whitelist user enabled))))
