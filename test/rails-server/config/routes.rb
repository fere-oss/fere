Rails.application.routes.draw do
  root 'pages#index'

  get  '/health', to: 'pages#health'

  resources :products
  resources :orders, only: [:index, :create, :show, :destroy]

  namespace :api do
    resources :reviews, only: [:index, :create, :show, :update, :destroy]
  end
end
